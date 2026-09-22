'use strict';
// Quests, claimed on their own. The game's Quests window has two tabs — the
// Routine tab (quest.getQuestType type 1) and the Daily tab (type 3), where
// the free daily amulet lives — and a finished quest sits there, paid or not,
// until someone presses Claim. Nothing in the fleet pressed it: the
// `completequests` script command (script-cmd-account.js) claims on demand,
// and no goal ever ran it, so every account's finished quests, the daily
// amulet among them, went unclaimed (the user, 2026-09-22).
//
// This is the goal that claims them, in every city that has goals, for ever.
// NEAT keeps the same thing in Global Settings ("Complete Quests", wiki
// CompleteQuests), a dropdown of four:
//
//   config completequests:0   no — nothing is claimed
//   config completequests:1   yes, except the Promotion quests
//   config completequests:2   yes, promotions in the order the game lists them
//   config completequests:3   yes, a title before a rank  (the default here)
//
// The key is ours: NEAT has no goal-file line for it. It DEFAULTS TO 3, so an
// account claims everything without a goal line written anywhere — which is
// what "always collect the daily amulet" asks for. A title is worth claiming
// on its own: the city cap is titleId + 1 (EVONY-RULES.md). Option 3 is the
// one NEAT's wiki recommends, and the only ordering that takes Baronet before
// Major.
//
// What it sends is what the game's own window sends (QuestCommands.as):
//   quest.getQuestType {castleId, type}     the tab's quest types, each with
//                                           isFinish: "something here is done"
//   quest.getQuestList {castleId, typeId}   that type's quests (QuestBeans)
//   quest.award        {castleId, questId}  the Claim button
// A type whose isFinish is false is never listed, so a quiet account costs
// exactly two requests a city a look. A claim re-reads the list, because a
// claim can open the next quest in a chain and a promotion can use up what
// another one needed (the same one-at-a-time loop as the script command).
//
// Paced per city: a look every QUEST_IDLE_MS when nothing was claimed, after
// QUEST_BUSY_MS when something was (more may have opened), QUEST_RETRY_MS
// after the server refused or said nothing. At most MAX_CLAIMS claims a run,
// so one slice can never turn into a long session.
//
// Per city, not per account: quest.getQuestList is asked WITH a castleId and
// the game's own window re-asks it when the current castle changes, so a city
// may have quests of its own; the account-wide ones (the daily amulet, the
// promotions) are claimed by whichever city looks first, and the rest then see
// nothing finished. A city with no goals at all is never visited by the
// engine, so an account emptied for a holiday claims nothing — as it should.
//
// Unclaimed is not lost: a finished quest waits, so a missed look costs
// nothing but time.

const C = require('./constants');

const n = (x) => Number(x || 0);

const DEFAULT_MODE = 3;             // claim everything, a title before a rank
const QUEST_IDLE_MS = 30 * 60000;   // nothing was finished
const QUEST_BUSY_MS = 60 * 1000;    // something was claimed: look again soon
const QUEST_RETRY_MS = 10 * 60000;  // the server refused or did not answer
const MAX_CLAIMS = 20;              // claims in one run
const REMEMBER = 10;                // quest names kept for the plan note

const MODE_TEXT = {
  0: 'nothing',
  1: 'everything but the promotions',
  2: 'everything',
  3: 'everything, a title before a rank',
};

// QuestBean.isFinish — done, and waiting to be claimed.
const finished = (q) => !!q && (q.isFinish === true || q.isFinish === 1);
const nameOf = (x) => String((x && x.name) || '').trim();
const eqi = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// A Promotion quest: one named after a title or a rank. The type is the one
// the game calls Promotion — or, whatever it is called, one holding nothing
// but promotions.
const isTitle = (q) => C.QUEST_TITLES.some((t) => eqi(t, nameOf(q)));
const isRank = (q) => C.QUEST_RANKS.some((t) => eqi(t, nameOf(q)));
const isPromotion = (q) => isTitle(q) || isRank(q);
const isPromotionType = (ty, list = null) => eqi(nameOf(ty), 'Promotion')
  || (Array.isArray(list) && list.length > 0 && list.every(isPromotion));

// ------------------------------------------------------------ the config key
const parsers = {
  // config completequests:0|1|2|3 (ours — NEAT keeps it in Global Settings).
  // Written as a line of its own (`completequests 3`), goals.js reads it as
  // the config key it means, as it does for every other one.
  completequests: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const v = value === undefined || value === null ? '' : String(value).trim();
      const num = Number(v);
      if (v === '' || !/^\d+$/.test(v) || !Number.isInteger(num) || num < 0 || num > 3) {
        errs.push(`completequests is 0 (claim nothing), 1 (all but promotions), 2 (all) or 3 (all, a title before a rank), not "${v}"`);
        return { mode: DEFAULT_MODE, errors: errs };
      }
      return { mode: num, errors: errs };
    },
  },
};

// The mode this city runs at. A key that is missing, or one no parser could
// read, leaves the default: claiming is on unless it is turned off on purpose.
function modeOf(config) {
  const raw = (config || {}).completequests;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MODE;
  const num = Number(raw);
  return Number.isInteger(num) && num >= 0 && num <= 3 ? num : DEFAULT_MODE;
}

// ------------------------------------------------------------------ the plan
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const span = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.round(s / 60)} min`; };

function summary(st) {
  const bits = [`${n(st.claimed)} claimed so far`];
  const l = st.last;
  if (l) {
    const what = l.error ? `failed (${l.error})`
      : l.claimed ? `claimed ${l.claimed} — ${(l.names || []).join(', ')}`
        : 'nothing finished';
    bits.push(`last look ${hhmm(l.at)}: ${what}${l.refused ? `; ${l.refused} refused (${l.refusal})` : ''}`);
  }
  return bits.join('; ');
}

function questsPlan(ctx, state) {
  const mode = modeOf((ctx || {}).config);
  const st = (state && state.quests) || {};
  if (mode === 0) return { note: 'quests: nothing is claimed (config completequests:0)', actions: [] };
  const head = `quests: claim ${MODE_TEXT[mode]} (Routine and Daily, the daily amulet among them)`;
  const now = Date.now();
  if (n(st.nextAt) > now) return { note: `${head}: ${summary(st)}; next look in ${span(n(st.nextAt) - now)}`, actions: [] };
  return {
    note: `${head}: ${summary(st)}`,
    actions: [{ kind: 'completeQuests', mode, label: `completequests: claim every finished quest here (${MODE_TEXT[mode]})` }],
  };
}

// -------------------------------------------------------------- the executor
// The next quest to claim from one type's list: the finished ones not tried
// yet, a title first under mode 3, else the game's own order (NEAT's option 2).
// Under mode 1 a promotion is never claimed.
function nextClaim(list, tried, mode) {
  const open = (list || []).filter((q) => finished(q) && !tried.has(Number(q.questId)));
  if (!open.length) return null;
  if (mode === 1) return open.find((q) => !isPromotion(q)) || null;
  if (mode === 3) {
    const title = open.find(isTitle);
    if (title) return title;
  }
  return open[0];
}

// One run, in one city. `state` is that city's engine state; it keeps
//   quests.claimed          how many have been claimed since the goal first ran
//   quests.last / .nextAt   the last look, and when the next one is due
async function runQuests(game, castle, a, state) {
  const st = (state.quests = state.quests || {});
  st.claimed = n(st.claimed);
  const mode = Number.isInteger(a && a.mode) ? a.mode : DEFAULT_MODE;
  const now = Date.now();
  const last = (st.last = { at: now, claimed: 0, names: [], refused: 0, refusal: null, error: null });
  const cid = game.castleId(castle);
  const say = (r) => String((r && r.errorMsg) || `ok=${r && r.ok}`).slice(0, 120);
  try {
    for (const tab of Object.keys(C.QUEST_MODES)) {
      const tr = await game.questTypes(cid, C.QUEST_MODES[tab]);
      if (!tr || tr.ok !== 1) throw new Error(`the ${tab} quest types came back ${say(tr)}`);
      // QuestTypeBean.isFinish: this type holds something finished
      // (QuestWin.countDoneValue). Only those are worth listing.
      const types = (Array.isArray(tr.types) ? tr.types : []).filter((ty) => ty && ty.isFinish !== false);
      for (const ty of types) {
        if (mode === 1 && isPromotionType(ty)) continue;
        const readList = async () => {
          const r = await game.questList(cid, ty.typeId);
          if (!r || r.ok !== 1) throw new Error(`${nameOf(ty) || `type ${ty.typeId}`} would not list (${say(r)})`);
          return Array.isArray(r.quests) ? r.quests : [];
        };
        let list = await readList();
        if (mode === 1 && isPromotionType(ty, list)) continue;
        const tried = new Set();
        while (last.claimed < MAX_CLAIMS) {
          const q = nextClaim(list, tried, mode);
          if (!q) break;
          tried.add(Number(q.questId));
          const r = await game.questAward(cid, Number(q.questId));
          if (r && r.ok === 1) {
            st.claimed++; last.claimed++;
            if (last.names.length < REMEMBER) last.names.push(`${nameOf(q)}${nameOf(ty) ? ` (${nameOf(ty)})` : ''}`);
          } else {
            last.refused++;
            last.refusal = say(r);
          }
          // a claim can open the next quest in a chain, and a promotion can
          // use up what another one needed
          list = await readList();
        }
        if (last.claimed >= MAX_CLAIMS) break;
      }
      if (last.claimed >= MAX_CLAIMS) break;
    }
    st.nextAt = now + (last.claimed ? QUEST_BUSY_MS : QUEST_IDLE_MS);
    return { ok: 1, msg: last.claimed ? `claimed ${last.claimed}: ${last.names.join(', ')}` : 'nothing finished to claim' };
  } catch (e) {
    last.error = e.message;
    st.nextAt = now + QUEST_RETRY_MS;
    // what was claimed before it broke still counts
    return { ok: 0, errorMsg: `completequests: ${e.message} — trying again in ${span(QUEST_RETRY_MS)}` };
  }
}

module.exports = {
  parsers,
  plans: { completequests: questsPlan },
  executors: { completeQuests: (game, castle, a, state) => runQuests(game, castle, a, state || {}) },
  configKeys: ['completequests'],
  // exported for the tests
  _internals: {
    DEFAULT_MODE, QUEST_IDLE_MS, QUEST_BUSY_MS, QUEST_RETRY_MS, MAX_CLAIMS, MODE_TEXT,
    modeOf, nextClaim, isPromotionType, isPromotion, isTitle, isRank, finished, runQuests, questsPlan,
  },
};
