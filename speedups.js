'use strict';
// Free finishes. The game finishes a construction or a research at no cost
// when it is a short job: when its PRESET time, the base time the client's
// tables give that level, is five minutes or less (C.FREE_SPEED). That is the
// early levels: the first four of a Farm, three of a Cottage, Sawmill or
// Quarry, two of an Ironmine or Rally Spot, the first of a Barracks, Stable,
// Inn, Forge or Feasting Hall, and Informatics 1. Each used to run its full
// time and hold the builder while the free finish went unused.
//
// What the client does, and so what this does:
//   construction  castle.speedUpBuildCommand {castleId, positionId, itemId: 'free.speed'}
//                 for a building upgrading (status 1; a new one is status 1 at
//                 level 0) whose level's base time is within the limit
//                 (BuildingBar.onBuildingSpeedUp :374-391, BuildingInfoWin.onSpeedUp
//                 :986-996, SpeedUpCheckOut.checkOutBuilding). A demolition
//                 (status 2) always goes to the paid item picker, never free.
//   research      tech.speedUpResearch {castleId, itemId: 'free.speed'}, the same
//                 test on the tech's level (TechReseachingUI.onSpeedUp :489-499,
//                 TechnologyBar.onTechSpeedUp :644-654).
//   troops, walls nothing: their batches have a free-speed handler
//                 (SWProduceUI.freeSpeed, CastleDefProduceUI.freeSpeed) that
//                 nothing calls; the speed-up button always opens the item picker.
//
// The time left plays no part: a job that qualifies does so from its first
// second to its last, and one that does not never will (a 20-minute upgrade
// with 4 minutes left is still a 20-minute upgrade). So there is no moment to
// catch and nothing to time. The engine checks each city twice a slice:
// before its plans (right after hiding and the gate, which race a wave and go
// first), so a job started since the last slice is finished before the build
// plan looks at the builder, and after its construction executor, so the job
// the slice has just started is finished in the same slice. An urgent war
// pass (hiding and the gate alone, between ticks) sends none: nothing here is
// ever in a race, so it waits for the city's regular slice.
//
// A free finish costs nothing and a job gets one at most, so none of this
// counts against the slice's action budget. A refused one is not asked again
// for that job. `config freespeedup:0` turns it off in a city; it is on by
// default. NEAT has no switch for it: its create command does it every time.
const C = require('./constants');

const n = (x) => Number(x || 0);
const LIMIT = C.FREE_SPEED.limitSec;
// A job may end a moment after its start plus its preset time (the server
// stamps both); anything longer is not the job the table describes.
const SLACK_SEC = 2;

// 45 -> "45s", 300 -> "5m", 150 -> "2m 30s"
function secs(sec) {
  const s = Math.max(0, Math.round(n(sec)));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
}

// The job's preset seconds when the game finishes it free, else null.
function presetSec(kind, typeId, level) {
  const row = (kind === 'research' ? C.FREE_SPEED.research : C.FREE_SPEED.building)[Number(typeId)];
  if (!row || level === null || level === undefined || !Number.isInteger(Number(level))) return null;
  const s = row[Number(level)];
  return s > 0 && s <= LIMIT ? s : null;
}

// What is running in this city: construction and demolition from the live
// building list, and the research the game object last saw (Game.runningResearch).
// A job over by the clock has nothing left to finish.
function jobsOf({ castle, research, now }) {
  const out = [];
  for (const b of (castle && castle.buildings) || []) {
    const status = n(b.status);
    if (status !== 1 && status !== 2) continue;
    if (!(n(b.endTime) > now)) continue;
    if (b.positionId === undefined || b.positionId === null || !Number.isFinite(Number(b.positionId))) continue;
    const level = n(b.level);
    const name = b.name || (C.BUILDING_BY_ID[b.typeId] || {}).name || `type ${b.typeId}`;
    out.push({
      kind: 'building', status, positionId: Number(b.positionId), typeId: Number(b.typeId), level,
      startTime: n(b.startTime), endTime: n(b.endTime),
      key: `b:${b.positionId}:${b.typeId}:${level}:${status}:${n(b.startTime)}`,
      label: `${name} (pos ${b.positionId}) L${level}->L${status === 1 ? level + 1 : level - 1}`,
    });
  }
  if (research && research.typeId) {
    const level = research.level;
    const preset = presetSec('research', research.typeId, level);
    // Without an end time, the preset time from when it was seen is as long as it can run.
    const end = n(research.endTime) || (preset ? n(research.seenAt) + preset * 1000 : 0);
    if (end > now) {
      const name = (C.TECH_BY_ID[research.typeId] || {}).name || `tech ${research.typeId}`;
      out.push({
        kind: 'research', status: 1, typeId: Number(research.typeId), level,
        startTime: n(research.startTime), endTime: end,
        key: `r:${research.typeId}:${level}:${n(research.startTime) || n(research.seenAt)}`,
        label: `research ${name} L${level === null ? '?' : level}->L${level === null ? '?' : level + 1}`,
      });
    }
  }
  return out;
}

// Which running jobs to finish now. Pure: reads the city, its config and the
// jobs already asked for (cityState.freeSpeed), sends nothing. `seen` holds the
// jobs an earlier pass of this slice has already listed (a dry run records none).
function freeSpeedPlan({ castle, config = {}, research = null, now = Date.now() }, cityState = {}, seen = null) {
  const asked = cityState.freeSpeed || {};
  const setting = config.freespeedup;
  const set = setting !== undefined && setting !== null;
  const off = set && Number(setting) === 0;
  const notes = [], finishes = [];
  const current = new Set();
  if (set && !off && Number(setting) !== 1) {
    notes.push(`config freespeedup:${setting} is read as on — 1 keeps free finishes on (the default), 0 turns them off`);
  }
  for (const j of jobsOf({ castle, research, now })) {
    current.add(j.key);
    if (j.status === 2) continue;             // demolition: never free
    const left = (j.endTime - now) / 1000;
    const preset = presetSec(j.kind, j.typeId, j.level);
    if (!preset) {
      if (j.kind === 'research' && j.level === null && C.FREE_SPEED.research[j.typeId]) {
        notes.push(`no free finish for ${j.label}: its level is not known yet (a research list read will tell)`);
      } else if (left <= LIMIT) {
        // the one that surprises: under five minutes left, and still not free
        notes.push(`no free finish for ${j.label} (${secs(left)} left): the game gives one only to a job whose preset time is ${secs(LIMIT)} or less, and this one's is longer`);
      }
      continue;
    }
    if (j.startTime > 0 && j.endTime > j.startTime && (j.endTime - j.startTime) / 1000 > preset + SLACK_SEC) {
      notes.push(`no free finish for ${j.label}: it runs ${secs((j.endTime - j.startTime) / 1000)}, longer than its ${secs(preset)} preset time, so it is not the job the client's table describes`);
      continue;
    }
    const prev = asked[j.key];
    if (prev) {
      if (!prev.ok) notes.push(`the free finish for ${j.label} was refused (${prev.msg}); not asked again`);
      continue;
    }
    if (seen && seen.has(j.key)) continue;
    if (off) { notes.push(`free finish for ${j.label} is off (config freespeedup:0)`); continue; }
    finishes.push({ ...j, preset });
  }
  return { finishes, notes, current, off };
}

// Send what the plan found. Each job is asked once: the answer, ok or refused,
// is kept in cityState.freeSpeed until the job is no longer running.
async function runFreeSpeed(g, castle, plan, cityState, { dryRun = false, seen = null } = {}) {
  const acted = [];
  const asked = (cityState.freeSpeed = cityState.freeSpeed || {});
  for (const k of Object.keys(asked)) if (!plan.current.has(k)) delete asked[k];
  if (!Object.keys(asked).length) delete cityState.freeSpeed;
  const cid = g.castleId(castle);
  for (const f of plan.finishes) {
    if (seen) seen.add(f.key);
    const line = `free finish ${f.label} (preset ${secs(f.preset)})`;
    if (dryRun) { acted.push(`[plan] ${line}`); continue; }
    let r;
    try {
      r = f.kind === 'research'
        ? await g.speedUpResearch(cid, C.FREE_SPEED.item)
        : await g.speedUpBuild(cid, f.positionId, C.FREE_SPEED.item);
    } catch (e) { r = { ok: 0, errorMsg: e.message }; }
    const ok = !!(r && r.ok === 1);
    const msg = ok ? '' : String((r && r.errorMsg) || `ok=${r && r.ok}`).slice(0, 120);
    (cityState.freeSpeed = cityState.freeSpeed || {})[f.key] = { at: Date.now(), ok, msg };
    acted.push(`${line} -> ${ok ? 'ok' : msg}`);
  }
  return acted;
}

module.exports = { freeSpeedPlan, runFreeSpeed, presetSec, configKeys: ['freespeedup'] };
