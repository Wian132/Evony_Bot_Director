# Scripts

A script is NEAT's script language: lines that run one after another, with labels,
jumps, conditions, variables, expressions and functions, and a command for nearly
everything the game can be asked to do. Goals say what a city should look like and
the engine gets it there; a script says what to do, now, in order. NEAT scripts
written for the wiki run here as they are, with the differences listed at the end.

The language is `script.js` (the line pointer and the statements), `script-expr.js`
(expressions) and `script-words.js` (troop, resource and building words). Commands
live in `script-cmd-<area>.js`, the game objects in `script-objects.js` and the
function library in `script-functions.js`. Each module's header lists its lines;
this page puts them together. The usage lines in the command sections below are
taken from the modules themselves (134 commands, 159 words that start a line,
35 in-line commands).

- [Where scripts run](#where-scripts-run)
- [The language](#the-language): lines, comments, `@`, variables, `%var%` and `{expr}`,
  expressions, control flow, functions, `execute` / `call` / `command`, `$result` and `$error`
- [Commands](#commands): [control](#control), [deployment](#deployment), [troops](#troops),
  [resources and the market](#resources-and-the-market), [city](#city), [hero](#hero),
  [account](#account), [social and in-line commands](#social-and-in-line-commands),
  [informational](#informational), [goals in scripts](#goals-in-scripts)
- [Objects and functions](#objects-and-functions)
- [The console](#the-console): Run at a line, Stop and Resume, `call`, autorun, `say` / `play`, `\command`
- [Safety switches and refusals](#safety-switches-and-refusals)
- [Differences from NEAT](#differences-from-neat), and [what is not done](#not-done)

## Where scripts run

Every city tab has ten script **loadouts**. The first line names one (`// farm
upgrades` is "farm upgrades"), and **Run** runs the open one in that city, alongside
any other city's run. One run per city at a time. The **Output** tab shows the run as
it goes, and **Stop** ends it once the line it is on finishes (a wait is cut short).
A run outlives the page: close the tab and it carries on; reopen it and the output is
still there.

**Apply** checks a script without running it. **A script with any error is refused
whole**, before anything is sent: an unknown command, a bad troop string, a `goto` to
a label that isn't there. A line whose text is only known when it runs (a `%var%`
that changes, `{expr}` in a command's arguments, anything `execute` builds) is checked
when it is reached; if it is wrong then, that line fails, `$error` says why, and the
script goes on.

The `/script` page is the old single-box editor, and it can only **dry run**: every
line is parsed and planned, and what would be sent is logged with `[dry run] not sent`.
Reads still happen in a dry run (prices, the map, lookups), so `$result` is real;
orders, marches, cancels and anything that changes the game are held back. A live run
comes from the Script tab, which sends each Run with an id (see
[below](#run-at-a-line-stop-and-resume)); a live request without one is refused.

**Scripts never log in.** They use the console's own session, follow it through a
reconnect (a script holds the current game, never a closed socket), and stop if the
console switches account under them. A command that needs the game while the console
is offline fails and says so.

## The language

### Lines

One statement a line. Blank lines are fine. The wiki's numbered listings (`1: sleep
5`) work as pasted: the number is dropped. Commands, keywords and labels are matched
in any case (`Goto`, `GOTO`), and so are the global names (`buildversion` is
`BuildVersion`). A true variable keeps its case (`e` is not the constant `E`); a
`%name%` finds it in any case.

### Comments and `@`

```
// a comment          # a comment         whole line
attack 111,222 any a:1k    // after code
get "http://x.com/a.txt"                  // inside quotes is no comment
@get "NewCityGoals.txt"                   runs without a word in the output
```

`//` starts a comment anywhere outside quotes; `#` only at the start of a line.
`@` first on a line runs it silently: nothing it logs reaches the output, not even a
failure (`$error` still says what went wrong). `@:` is a time (`attack … @:14:30:00`),
never the silent prefix.

### Variables

Two kinds, as in NEAT.

**True variables** hold any value and are assigned with `=`:

```
x = 5
x += 2      x -= 1      x *= 3      x /= 2      x %= 4      x++      x--
list = ["a", "b"]      list[0] = "c"      list.push("d")
o = {name: "Fla", wood: 20k}      o.wood = 30k      o["key with spaces"] = 1
```

A name nobody has assigned reads as `undefined`, as in NEAT (`ifgosub castle found`
relies on it), and Apply warns about it. The constants (`PI`, `BuildVersion`,
`ResourceNames`, `BuildingTypes`...) cannot be assigned. Variables are the script's
own: every run starts with none, and `call` hands them to the script it calls.

**Replacement variables** are NEAT's `set`: plain text swapped into later lines.

```
set target 111,222
attack %target% any a:1k
```

`%name%` is filled in **when the line runs**, so a `set` inside a loop changes what the
next round sends. A `%name%` with no `set` reads the true variable of that name, so
`%x%` works after `x = 5`. A `%name%` that is neither is refused before the run.

`$result` and `$error` are set after every command (below).

### Text: `%var%` and `{expr}`

Inside double quotes, `{expr}` is filled in with the expression's value:
`echo "{city.name} has {city.troop.archer} archers"`. A `{` that doesn't hold a whole
expression stays as it is; `\{` is always a `{`. Single-quoted text is taken as
written. In a command's arguments `{expr}` works too (`train a:{need} atk`): the line is
parsed when it runs. Escapes: `\n \t \r \" \\`.

### Expressions

```
numbers    12  1.5  0x1f  1e3  20k  1.5m  2b  2%        (k m b = thousand, million, billion; 2% = 0.02)
strings    "a\tb {x + 1}"  'no {filling} here'
literals   true false null undefined NaN Infinity  [1, "a", [2]]  {a: 1, "b c": 2}  /re/gi
operators  ?:   || or   && and   |  ^  &   == = != <> === !==   < <= > >=   is in
           << >> >>>   + -   * / % MOD   ! - + ~   a.b  a[i]  f(x)
```

- `=` inside an expression compares, as NEAT's `if a = 1` does; a statement `x = 1`
  assigns. `<>` is not-equal. `and`, `or` and `MOD` work in any case.
- `x is Array`, `x is Number`, `x is String` (also int, uint, Boolean, Object, Function,
  Date, RegExp, null, undefined) test a value's type; `"food" in city.resource` asks
  whether a key is there.
- `(a + b) (c - 1)` multiplies, as NEAT reads it.
- Strings, numbers, arrays, dates and regexes have the usual JavaScript methods
  (`s.substr(3, 2)`, `s.split(",")`, `s.replace(/x/g, "y")`, `n.toFixed(2)`,
  `a.indexOf(v)`, `a.slice(1)`, `d.getHours()`...), and their names match in any case as
  NEAT's did (`subStr`, `toupperCase`, `IndexOf`). `localeCompare` gives ActionScript's
  answer (the difference of the first differing characters). `forEach map filter some
  every find findIndex reduce sort sortOn toArray` run inside the language, so the
  callback can be a script function or a `CreateFunction`.
- `CreateFunction("a, b", "a + b")` makes a function value; its body may assign
  (`total += c.troop.archer`) and sees the script's variables when it runs:
  `cities.forEach(CreateFunction("c", "echo c.cityManager.name"))`.
- Every regex match runs in a worker with a 2-second limit, so a runaway pattern fails
  its line instead of freezing the console.
- There is no `eval`: `__proto__`, `prototype`, `constructor` and every `__name` are
  never read or written, and a script only ever holds copies of game state.

### Control flow

```
label name                         a place to jump to (one word)
goto name
gosub name  ...  return            also gosubreturn; up to 1,000 deep
if (cond) <any line>               the brackets are optional; if a == 1 if b == 1 echo "both"
ifgoto (cond) name | ifgosub (cond) name       NEAT's older forms
loop | loop 0                      back to the top, forever
loop 5                             the whole script runs 5 times in all
loop name | loop 5 name | loop name 5          back to label name, forever | 5 times in all
loop 3 ... endloop                 OTTObot's block: the lines between run 3 times
repeat 10                          the last line that ran, until it has run 10 times in all
repeat | repeat 0                  the last line again and again, until it fails or Stop
sleep 5 | sleep 1:30 | sleep 1:00:00 | sleep @:14:15 | sleep rnd:300 | sleep rnd:300:600
end | exit                         the script ends here
stop                               pause here until Resume (Stop ends it)
die "message"                      end with an error: $error is the message
```

- `if` runs any line when the condition is true: a command, `goto`, `gosub`,
  `execute`, an assignment, another `if`. `&&`, `||`, `and`, `or` all work (the
  Operators page wins over the If page).
- A jump can't cross a function's edge, and a label is refused twice.
- `loop` and `repeat` count **in total**: `repeat 5` after a line runs it five times
  altogether (`repeat 1` adds nothing), as the wiki's examples mean it. OTTObot used to
  read `repeat N` as N more times, so an old `buy food … / repeat 500` loadout now
  places 500 orders, not 501. A bare `repeat` stops when the line fails.
- A `repeat` under an `if` reads the condition again before every round, as NEAT goes
  back and reads the `if` again: `x = GetDetailInfo(id)` / `if !x repeat` asks until
  the details arrive. A bare `repeat` right after `buyitem` is refused (it would buy
  until the cents ran out): give it a count.
- **Flood guard.** A line the server refused, reached again (by `goto`, `loop` or
  `repeat`), waits 200 ms before it is sent again, and the same line refused 10 times in
  a row ends the run. A line that goes through starts the count over. Without this, a
  loop around a refused order would send as fast as the server answers.
- `sleep rnd:300` waits a random 0-300 s; `rnd:300:600` 300-600 s. `sleep @:14:15` waits
  until 14:15 on this machine's clock (tomorrow if it has passed).
- `exit` is `end`: it never closes the console. `stop` pauses the run and shows
  **Resume** in the console (below); where nothing can resume it (a test, a run
  without the console), it ends the script and says so.
- In a dry run an endless `loop` or bare `repeat` says what it would do and moves on.

### Functions

```
function addTax(amount, rate)
  return amount * (1 + rate)
endfunction

total = addTax(100, 5%)
callfunc addTax(100, 5%)            the value lands in $result
```

When the script reaches a `function` line it skips the body, so a function can sit
anywhere. The body runs to its `endfunction` (`end function` works too); without one it
runs to the next `function` or the end of the script, so close every function that
isn't last (Apply warns when lines after its last `return` would be swallowed).
Arguments are local; every other name is the script's. `return` with a value gives it
back; without one, `undefined`. A function can call itself, 200 deep at most.

### `execute`, `call` and `command`

```
execute "goto city" + city.timeSlot           build a line and run it
execute "attack " + target + " any a:1k"
execute $result                               findfield's attack lines, one after another
call "farm upgrades" | call load3 | call "UseItems.txt"
command "who " + name                         an in-line command
```

- **`execute`** takes an expression and runs its text as a line: a command, a `goto`
  or `gosub` (it jumps), an assignment. Several lines run one after another; a line with
  a `(`, `[` or `{` still open goes on into the next, so `execute "members = [ " + … `
  builds a list across lines. A label or function can't be made this way.
- **`call`** runs another script with this one's true variables (not its `%vars%`), and
  comes back at its end or at a top-level `return` (whose value is `$result`). A
  loadout of the run's city by slot (`call 3`, `call load3`, `call "Load 3"`) or by the
  name on its first line, or else a file in the console's scripts folder. Not a URL
  (see [The console](#call)). 20 deep at most.
- **`command`** runs one of NEAT's in-line commands (`who`, `members`, `invite`...,
  [the list](#in-line-commands)). Its text lands in `$result`; a failure in `$error`.

### `$result` and `$error`

After every command line the language sets both:

- **`$error`** is `null` when the line worked and the reason when it didn't, so both
  NEAT forms work: `if $error goto retry` and `if $error == null goal $result`.
- **`$result`** is what the command gives back: a list for the `list…` commands, a
  name for `findhero`, a count for `rewardheroes` and the recalls, the text for `get`
  and the in-line commands, the field ids for `findfield`. A command with nothing
  special to give (a march, a build) leaves the text it logged. `callfunc` and `call`
  put their return value there.

A failed line never stops the script by itself: it logs `FAILED: <why>`, sets
`$error`, and the next line runs. Test `$error` where it matters, or `die`.

### `echo` and `print`

```
echo "My city is at " + city.coords + " with" cavs "cavalry"
echo 1 + 1
print text with %vars% only
```

`echo` prints expressions side by side, joined with a space (NEAT's juxtaposition).
Quoted text is literal, `\n` breaks the line, a quote left open at the end of the line
closes there, and a word nothing defines prints as written, so `echo Done` prints
`Done`. A line that isn't an expression prints as written. `print` is NEAT's older
form: plain text, `%vars%` only.

## Commands

**How to read them.** `<x>` is a value you give, `[x]` may be left out, `a | b` is one or
the other. Every command's usage is also in the console: `listcommands` prints them
all, `listcommands hero` the ones whose names hold "hero", and a line that can't be
read says what to write instead.

**Coordinates** are `x,y`; many commands also take one of your cities by name (in
quotes when it has spaces).

**Troops first, resources second.** `a:5000,c:20k` is troops (`w wo s p sw a c cata t b r
cp`, NEAT's `arch warr cav ram br pult trans phract`, or full names; k/m/b amounts).
Resources are `f w s i g` (`l` for lumber too) or full names. On a march line the first
list is troops and the second resources, so `s:` and `w:` mean scouts and warriors first,
stone and wood second.

**Hero strings** (NEAT's HeroString) wherever a line names a hero:

```
ken | bob,fred | !Biggy,any:attack>180 | any:attack=best | any:base>60,attack<300
bob,fred|any:attack>=60 | att*:attack>200 | att??int:base>=69 | none
fields   attack|att politics|pol intel|int loyalty|loy level|lvl experience|exp points|pts base|bse
compare  < > = != <> <= >= against a number (20k), another field, best or worst
```

Only an idle hero of the city goes: never one that is out, the mayor, a prisoner, or one
this script sent in the last minute. Named heroes are tried in the order written; with
`any` an attack takes the strongest attack hero. `best` and `worst` are measured against
the whole city. `!Name` is a real veto. The wiki writes `!BigGuy` where the `!` only
stops a wiki link: on commands that act on one hero (`mayor`, `fire`, `levelup`...)
`!Name` finds Name when no hero is called `!Name`. A bare number is refused, as NEAT
refuses it.

**Times.** `@:14:30:07.500` is a moment on this machine's clock; `1:30`, `1:30:00` or
`90` are lengths of time. On a march, `@0:30:00` or a bare `0:30:00` is camp time.

**Dry run.** Every command logs what it would send and `[dry run] not sent`, and sends
nothing that changes the game.

### Control

The control words (`label goto gosub return if loop repeat sleep end exit stop die echo
print set execute call command function callfunc`) are [the language](#control-flow).
NEAT's control-structures page also lists three commands that reach outside the game:

```
say "<text>" | say "es# <text>" | say <expression>
play <file.mp3> | play "<http(s) link>"
post <url> [data] | post /form <url> <object>
```

- **`say`** speaks in the open console tabs with the browser's voice. It takes an
  expression: `say city.name + " has " + city.NumberOfRealAttacks + " incoming attacks"`.
  A two-letter language code and `#` first picks the voice (`say "es# Tu ciudad esta
  siendo atacada."`). The line says how many tabs it reached; with none open nothing is
  heard.
- **`play`** plays a sound in the open tabs: a file from the console's media folder
  (`play alarm.mp3`, or NEAT's `play "media/SingleAttack.mp3"`), or an `http(s)` link.
  .mp3, .wav, .ogg or .m4a. A file that isn't there beeps instead. Never a path
  elsewhere on this computer.
- **`post`** sends data to a web address: an object or array goes as JSON, anything else
  as text; `post /form` sends a flat object as a form (what a PHP page reads from
  `$_POST`). 15 s timeout; `$result` is the reply's text (up to 100 kB); an HTTP status
  of 400 or more fails the line, and a redirect is not followed. Addresses on the public
  internet only. A console bound to loopback (the default, `BIND` unset) may also post to
  localhost and private addresses, as NEAT's own example (`http://localhost:8080`) does.

NEAT played sounds on the bot's PC; here they play in a console tab, and a browser plays
sound only after you have clicked somewhere on the page once (the editor hint says what
was not heard).

### Deployment

```
attack <x,y | city> <hero> <troops> [resources] [@:hh:mm:ss | camp] [/big] [/horde] [from <city>]
scout <x,y | city> <hero | none> <troops> [@:hh:mm:ss | camp] [/big] [from <city>]
transport <x,y | city> [hero] <troops> <resources> [@:hh:mm:ss | camp] [/big] [from <city>]
reinforce <x,y | city> [hero] [troops] [resources] [@:hh:mm:ss | camp] [/big] [from <city>]
deploy <at|bu|re|sc|tr> <x,y | city> [hero] <troops> [resources] [@:hh:mm:ss | camp] [/big] [/horde] [from <city>]
bigattack <x,y> <hero> <troops> [...] — attack with a War Ensign
bigscout <x,y> <hero | none> s:<scouts> [...] — scout with a War Ensign
bigtransport <x,y | city> t:<transports> <resources> [...] — transport with a War Ensign
bigreinforce <x,y | city> [hero] [troops] [resources] [...] — reinforce with a War Ensign
bigdeploy <atk|bld|rei|sct|tr> <x,y | city> [hero] <troops> [resources] [time] — deploy with a War Ensign
recall <x,y | city>
recallall
idrecall <armyId>
recallhero <hero string>
travelinfo <x,y | city> <troops> [from <city>]
buildstatus
marchcheck
setballsused <n,n,n,n,n>   (retired: config ballsused:<n> in the goals)
```

**Marches.** `attack`, `scout`, `transport`, `reinforce` and `deploy <type>` send one
march from the run's city, or from another of yours with `from <city>`. `deploy` takes
`at` attack, `bu` build city, `re` reinforce, `sc` scout and `tr` transport (also `atk
attack`, `bld build buildcity construct`, `rei reinforce`, `sct scout`, `transport`).
The target is `x,y`, or one of your cities by name (`reinforce Fla`,
`reinforce "Home City" none a:500 wood:50k,food:20k`).

- Attack and scout need a hero word: a name, `any`, a hero string, or `none` (a scout
  may go without a hero: `scout 111,222 none s:25000`). `scout 111,222` on its own sends
  1 scout with no hero (CompleteQuests' "Scout city"). Reinforce and transport go
  without a hero when none is named, and a reinforce with no troops sends 1 scout, as
  NEAT does.
- Resources that more than fill the troops' hold, less the march's food, are refused
  before anything goes, as the game's march window refuses them. When the city's
  Logistics can't be read, it is sent with a warning and the server decides.
- `/big` spends a War Ensign you hold, for 25% more troops; it is never bought for you.
  It goes only while the loaded inventory shows one, less those this run has used
  already (an inventory that hasn't loaded counts as none). `bigattack`, `bigscout`,
  `bigtransport`, `bigreinforce` and `bigdeploy` are the same lines with `/big`.
  `/horde` ticks the march window's Horde box.
- `@0:30:00`, `@30:00` or a bare `0:30:00` camps the march that long first. Plain
  `@hh:mm:ss` used to be a landing time here; like NEAT, it is camp time now.
  `@:hh:mm:ss[.fff]` lands it at that moment (below).

**Recalls.** `recall x,y` brings back every army of yours on its way to, or staying at,
x,y. `recallall` recalls every army that left this city and isn't already coming home.
`idrecall` recalls one army by id (`city.selfArmies[0].armyId`...). `recallhero`
recalls the one hero of this city that is out and matches (one per line). `$result` is
how many were recalled.

**`travelinfo 111,222 cav:10,cata:10`** reports without sending: the distance, the
attack and reinforce times for those troops (this city's skills and buffs included),
what they carry, and what is left after the march's food.

**`setballsused`** is refused and points to `config ballsused:<n>` in the goals: NEAT's
own wiki retired it.

#### Timed marches and extra cities

An `@:` march (`timed-march.js`) is sent to the millisecond. Its march time is worked out
the way the client does it (`C.marchTimeMs`): the slowest speed held in an int, the drive
skill for mounted troops and siege, the sending city's Relief Station when the target is
yours or your alliance's, the map's wrap-around, and the march-time buffs. Camp is whole
seconds, so the fraction is taken up by holding the send back. After the send, the
server's own `reachTime` for the new army is checked, against the aimed moment for the
first march and against the marches already due for every later one, from any city's
script. A march that misses the second is recalled at once and sent again, up to three
tries. The miss is learned (a network lead, or a speed factor for that city and kind of
tile), so the next march is right first time. A stamp that no speed rule could explain is
reported and left alone. Aim mid-second (`.500`): an aim on a second boundary can be split
across two seconds by a few ms of network jitter. **`marchcheck`** holds the formula
against the server's own start and arrival times for every march the account has out,
with and without the Relief Station. It costs nothing in game, so it's worth running
before a real attempt.

This is what the extra-cities trick needs. The server checks the city limit
(`titleId + 1`: 10 cities for a Prinzessin) when a build is sent, not against the builds
already on their way, so many `deploy bu` marches sent with one slot open, all landing in
the same second, can go over it. `city-build.js` refuses a build before it is sent when the
target isn't a flat you hold, when another build march is already heading there, or when
no city slot is open. **`buildstatus`** lists every build march on its way, grouped by the
second it lands in. Flats taken after login reach the console (`server.CastleFieldUpdate`).
Once the builds are out, `logout now <back>` takes the console off the game until they
have landed ([account](#account)).

#### Background attacks

```
spamattack <x,y> <troops> <waves>
endspamattack [all]
loyaltyattack <x,y> [troops | cavalry] [/waves=100] [/hours=12]
capture <x,y> [troops | cavalry] [/waves=100] [/hours=12]
endloyaltyattack [all]
guardedattack <x,y> <troops> <scouts> <their troops> <their defenses>
setguard <x,y> <their troops> <their walls>
endguardedattack [all]
attackstatus
```

NEAT runs these beside the script (`deploy-loops.js`): the line that starts one returns
at once, the script carries on or ends, and the attack keeps going until its `end…` line.
The console's **Stop** ends the script, not these; `attackstatus` lists what is running.
Each writes to the Log tab under its city, waits while the console is offline, and stops
if the console switches account.

- **`spamattack 111,222 c:500,s:500 10`**: 10 waves, one after another, each led by an
  idle SpamHero at 100 loyalty. SpamHeroes are the city's `spamheroes` goal lines, or
  NEAT's default `any:base<=69,level<50`.
- **`loyaltyattack 111,222 s:100,c:5k`** sends a wave every 30 s until a report shows the
  target's loyalty at 7 or lower; **`capture`** keeps going until the city is taken. A
  bare number is cavalry (`capture 111,222 3000`); no troops is 500 cavalry. A battle lost
  there recalls every attack of yours on its way to it, from any city. Both stop after 100
  waves or 12 hours (`/waves=N`, `/hours=N` on the line change that), or when 3 reports
  about the target in a row can't be read (the waves would go on blind).
- **`guardedattack 111,222 cav:99000,s:1000 10 a:500000 ab:1`** sends the attack now and
  10 scouts timed to land 15-30 s ahead of it. The attack is recalled if the scouts die,
  bring no report, or see `a:500000` or `ab:1` or more there. **`setguard`** keeps the
  same watch over an attack and scout already sent.
- `endspamattack`, `endloyaltyattack` (it ends `capture` too) and `endguardedattack` (and
  `setguard`) end this city's; with `all`, every city's.
- One of each kind per target and city: the same line again while its task runs (a
  script loop, a second run) starts nothing and says how to end the one running. A
  console runs 10 background attacks at most.

They know what happened from the army reports, opened one at a time (so they show as read
in the game too). A battle report gives only the change in loyalty, and only a scout
report gives the level, so `loyaltyattack` starts from your latest scout report of the
target and refuses to start without one. They don't survive a console restart.

### Troops

```
train <type:qty> [hero] [barracks plot | all | idle] [minimum]   or  train <troop> <amount>
disband <troops>  |  disband /keep <troops>   e.g. disband w:25k
dumptroop <x,y> <when troops> <send troops>   e.g. dumptroop 111,222 a:99000,s:50000 a:20000,s:15000
healtroops
canceltroopqueues [n] | cancelfortifications [n]   (also: canceltroops, cancelwalls, clearwallqueue)
```

- **`train a:5000 [hero] [barracks | all | idle] [minimum]`** is NEAT's form: one troop
  type across all barracks (or the one on that plot, or only the idle ones), as many as
  the resources and idle population allow up to the amount. With a minimum, fewer than
  that queues nothing. A hero (`any`, `atk` or a name) is made mayor for the order, and
  the old mayor comes back after. `train help` prints examples. OTTObot's
  **`train a 10k`** trains exactly that many in the first barracks.
- **`disband w:25k`** dismisses 25,000 warriors at home, for good. **`disband /keep
  w:25k`** dismisses warriors down to 25,000, counting those out on marches as kept.
- **`dumptroop 111,222 a:99000,s:50000 a:20000,s:15000`** reinforces x,y with the second
  list if the city holds the first; not yet, and the line fails with `$error` saying
  what is short (so a script loops on it).
- **`healtroops`** heals the whole medic camp, for city gold.
- **`canceltroopqueues [n]`** and **`cancelfortifications [n]`** (`queue-cancel.js`) empty
  the barracks and the Walls queue in the run's city. `n` batches stay in each barrack (or
  in the Walls queue), and every batch after them is cancelled; with no `n`, every batch
  goes. Batches are cancelled from the back, so the one in training goes last.
  `canceltroops`, `cancelwalls` and `clearwallqueue` do the same. To cancel one batch by
  hand, use the ✖ beside it in the **Barracks queues** or **Fortifications** panel. A
  troop or fortification goal that is still short queues more on the engine's next pass,
  so pause the engine first to keep the queues empty.

### Resources and the market

```
buy <food|wood|stone|iron|0-3> <amount> <price>   (or @price)
sell <food|wood|stone|iron|0-3> <amount> <price>   (or @price)
canceltrade [tradeId ... | buy | sell | food | wood | stone | iron]
marketupdate <0-3 | food | wood | stone | iron>   (none or all: all four)
dumpresource <x,y | city> <when> <send>   e.g. dumpresource 111,222 f:11000,g:44000 f:3000,g:9000
holidaysnipe [dry] | holidaysnipe stop | holidaysnipe status
```

- **`buy food 10000 6`** bids for 10,000 food at 6; **`sell food 20000 8`** offers 20,000 at
  8. The resource can be a number, 0-3 = food wood stone iron (what the STS trading script
  writes: `execute "sell " + res + " " + amount + " " + price`). k/m/b amounts, and
  OTTObot's `@price` and `lumber` work too. The price goes out the way the market's price
  box takes it (at most 5 characters, at most 150): a buy is rounded down and a sell up,
  so an order never pays more, or takes less, than the line gives. One order is at most
  99,999,999. A price over 150, a bigger amount, or extra words are refused.
- **`canceltrade`** cancels every open order of this city; `canceltrade 123456` that one
  (`execute "canceltrade " + city.tradesArray[0].id`); `canceltrade buy | sell | food`
  (OTTObot's) the bids, offers or one resource's. A bare number is always a trade id.
- **`marketupdate wood`** reads that book now (none or `all`: all four).
- **`dumpresource 111,222 f:11000,g:44000 f:3000,g:9000`** transports the second list to
  x,y once the city holds the first, with as many transporters as the load needs; not
  yet, and `$error` says what is short. (The wiki's DumpResource is this conditional
  transport.)
- Market writes are paced: a run waits 1.2 s between them, and each unanswered one in a
  row doubles that, up to a minute.

Prices, for expressions (also `m_context.buyPrice/sellPrice` and `city.buyPrice/sellPrice`):

```
BuyPrice(res[, amount[, method]])    the highest bid: what a sell gets now          res 0-3 or a name
SellPrice(res[, amount[, method]])   the cheapest offer: what a buy pays now
Price(res, q)                        q of the way from the best bid (0) to the best offer (1)
m_context.marketReady()              false after a (re)login until all four books have been read
MAX_TRADE                            99,999,999, the most one order takes (assignable)
ResourceIntNames                     ["food", "wood", "stone", "iron"]
```

`amount` and `method` are NEAT build 2635's: method 0 (the default) is the price that
fills `amount` at once, walking the book; 1 is the average over those levels. NaN when the
book shows less than that. Books are read on demand and kept 15 s. `Price` is derived
from the wiki's STS trader, the only place it appears (it bids at `Price(res, 2%)`).
`marketReady()` reads the books that aren't fresh itself, since nothing else in OTTObot
polls the market. The wiki's STS v0.10g trading script runs.

**`holidaysnipe`** (`holiday-snipe.js`) keeps running after the script returns. It
watches the market, and when food, wood, stone or iron is offered under 1 gold it bids
the best ask + 0.01 in every city with over 1b gold: ten 99m orders each, all cities at
once, and ten more for as long as they fill. It never takes a city under 1b and cancels
whatever does not fill. The server keeps the 0.5% fee on a cancelled order, and charges
your bid, not the seller's price, so after a round where nothing fills it leaves that
resource alone for 30s, doubling each time it happens again (up to 10 min).
`holidaysnipe dry` only says what it would buy; `holidaysnipe status` and `holidaysnipe
stop` do what they say (a dry run of `stop` says it would stop the sniper and leaves it
running). Every default can be changed on the line, e.g. `holidaysnipe under:0.5
floor:2b`.

### City

Buildings:

```
create <type> [plot] [/speedup=<items>] [/nowait]
build <building> [at <plot>]   (build c:10:9 is the build goal)
upgrade <type> [levelX | lowestlevel [X] | highestlevel [X]] [at <plot>] [/speedup=<items>] [/nowait]   (bare upgrade: any building below 9)
demo <type | any> [levelX | lowestlevel [X] | highestlevel [X]] [@plot] [/dynamite] [/speedup=<items>] [/nowait]   (also: demolish)
demosite [/dynamite] <plot>
cancelbuilding [@plot]
buildingspeedup [@plot] <item[,item]>   e.g. buildingspeedup Senior Guidelines
```

- **`create <type> [plot]`** is NEAT's: a new building on a free plot, or on that plot
  (`create a 0`, `create embassy 2`). OTTObot's **`build cottage [at 12]`** does the same
  at once, with no waiting. `build c:10:9` and `build ?w:10?q:0:0` are NEAT's build
  **goal**, and go to [goals in scripts](#goals-in-scripts).
- **`upgrade <type> [policy] [at <plot>]`** takes the lowest-level one up a level, never
  past 9 without a policy. A bare **`upgrade`** is NEAT's: the lowest building or field of
  any type below 9 whose prerequisites are met, so `upgrade` / `repeat` takes everything
  to 9. **`demo <type | any> [policy] [@plot]`** takes one level off
  (a level-10 building only with `level10` or `highestlevel 10`); **`demosite <plot>`**
  takes one level off whatever stands there. Neither ever touches the **Town Hall or the
  Walls** (plots -1 and -2), with or without `/dynamite`: the game's client has no
  Destruct for them, and a city without its Town Hall is lost. **`cancelbuilding
  [@plot]`** cancels the construction under way.
- Types are NEAT's words (`a b be c e fh fo f s q i inn m r rs st t w wh ws`), the names
  (`iron mine`, `feasting hall`) and `house saw iron barrack`. Policies: `levelX` (`le X`)
  one at level X, and `level9`/`level10` take a level-9 one to 10, spending a
  Michelangelo's Script; `lowestlevel[ X]` (`lo`) the lowest, below X; `highestlevel[ X]`
  (`hi`) the highest, below X (upgrade: 10 by default, so it may spend a Script; demo: at
  or below X, 9 by default).
- `create`, `upgrade`, `demo` and `demosite` **wait**: while the builder is busy, while
  resources come in (when they are coming), and for the job to finish. `/nowait` skips
  only that last wait. Stop ends any wait. A job the game finishes free (5 minutes or
  less) gets the free speed-up by itself.
- **Speed-ups**: `/speedup="Ultimate Guidelines,Beginner Guidelines"` applies held items in
  order until the job is done; `buildingspeedup` and `researchspeedup` do it for a job
  under way. Items: Beginner, Primary, Intermediate, Senior, Master and Ultimate
  Guidelines, their ids (`consume.2.a`...), and `free`. An item, and `/dynamite`'s
  Dynamite, goes out only while the loaded inventory shows one held: the game **buys** a
  missing one with cents, so none is ever sent unseen. Coins (the Instant Finish) are off
  ([safety](#safety-switches-and-refusals)).

Research:

```
startresearch <tech | quickest | cheapest | dearest> [/nowait] [/speedup=<items>]
research <tech>   (research lo:5 is the research goal)
cancelresearch
checkresearch   ($result: the techs this city can start now)
researchspeedup <item[,item]>   e.g. researchspeedup Senior Guidelines
```

- **`startresearch <tech | quickest | cheapest | dearest>`** waits, like `create`: for
  the research already running there, for resources, and for the job (`/nowait` skips
  that last wait). OTTObot's **`research <tech>`** sends at once. `research lo:5`
  is NEAT's research **goal**. `checkresearch` puts the techs this city can start now in
  `$result`. Techs: `ag lu mas mi met in ms mt ir lo com ho ar st/sp med con en mac pr`, or
  the names.

Walls:

```
walldefense <type> [qty] [build | demo | keep]   or  walldefense [/demo | /keep] tra:1k,ab:1k,at:5k
wall <trap|abatis|tower|logs|rocks> <amount>   (also: walls)
```

- **`walldefense abatis 1000`**, or several at once (`walldefense tra:1k,ab:1k,at:5k`),
  queues that many. With `demo` (or `/demo`) it demolishes that many, as many as stand;
  with `keep`, it demolishes down to that many. Bare `walldefense` builds 1 trap. It only
  touches the defences on the Walls: naming the Walls or the Town Hall is refused.
  OTTObot's **`wall abatis 1000`** builds.

Running the city:

```
production <food> <wood> <stone> <iron>   (also: produce)
tax <0-100>  (settaxrate)
comfort <1-4 | relief | pray | bless | popraise>
levy <1-5 | gold | food | wood | stone | iron>
renamecity <new name> [picture 1-4]   (a name with spaces in quotes; 10 letters at most)
setfocus [cycles]   (nothing to do: every city gets every tick)
```

- **`production 100 100 50 50`** sets the four labour percentages. **`tax 20`** (also
  `settaxrate`) the tax rate. **`comfort <1-4 | relief | pray | bless | popraise>`**
  comforts once. **`levy <1-5 | gold | food | wood | stone | iron>`** levies once.
  **`renamecity <name> [picture 1-4]`**: 10 letters at most, the game's limit.
- These act once. NEAT's `production` also held the percentages until a restart, and
  its comfort, tax and levy have goal halves (`config comfort:1`, TaxPolicy): those are
  the goals'.
- **`setfocus [cycles]`** is accepted and does nothing. NEAT gave the city the bot's next
  task cycles; here the goals visit every city every tick.

Valleys, towns and moving:

```
abandon <x,y>   (a valley or flat of yours)
abandontown <x,y | city> confirm [anyway]   — gives the city up for good (off unless the console starts with OTTO_ALLOW_ABANDON_TOWN=1)
evacuatetown <x,y> confirm   — every troop, and all they can carry, reinforce x,y
endevacuate [x,y]   — recalls the evacuation march(es) from this city
buildcity <x,y> [hero] [troops]   (also: newcity)
cancelbuildcity [x,y]
teleport <x,y> | teleport <state> | teleport random | warteleport <x,y>   [from <city>]
autoteleport [<state> | random] [all confirm] [/tries=5] [/every=5:00] [/norecall]
```

- **`abandon x,y`** gives up a valley or flat of yours; `$error` is set when it didn't go,
  so the wiki's AbandonAllValleys loop runs. (`config abandon:1` is a goal.)
- **`abandontown <x,y | city> confirm`** gives the city up for good. It is off unless the
  console was started with `OTTO_ALLOW_ABANDON_TOWN=1`, and even then it gives up only a
  city the city registry records as abandonable (one `buildnpc` built), never the last
  city. `confirm` is required, and `anyway` too while heroes, troops or marches would be
  lost there. The game asks for the password's SHA1, which only the goals update's login
  keeps, so it fails and says so until that is merged.
- **`evacuatetown x,y confirm`**: every troop, and all they can carry, reinforce x,y in
  one march. **`endevacuate`** recalls it.
- **`buildcity x,y [hero] [troops]`** (also `newcity`) captures the flat first when it isn't
  yours (troops by its level when none are given), then founds the city.
  **`cancelbuildcity`** stops one still waiting on its capture.
- **`teleport`** (`teleport.js`) moves the run's city, or any city with `from <city>`.
  Which teleporter it spends depends on the target:

  | line | spends | lands |
  |---|---|---|
  | `teleport 212,312` | Pioneer Express Teleport if held, else Advanced Teleporter | on that empty flat |
  | `warteleport 212,312` | War Teleporter | on that NPC camp |
  | `teleport thuringia` | City Teleporter | somewhere random in that state |
  | `teleport random` | City Teleporter | in a state picked at random |

  Before it sends anything, it checks that the item is held (an inventory that hasn't
  loaded counts as none) and that the target isn't one of your own cities. Coordinates are read off the live map first: a flat for `teleport`,
  an NPC camp for `warteleport`. When the tile type is wrong it refuses and names the
  command that would work. The move itself is the server's call, and a refusal comes back
  with the server's reason. Once a city has moved it is never abandonable by `buildnpc`.
- **`autoteleport [<state> | random] [all confirm]`** is NEAT's AutoTeleporter: recall the
  city's armies, wait for them, teleport, and retry (`/tries=5`, `/every=5:00`;
  `/norecall` skips the recall). `all` moves every city and takes `confirm`. With no state
  it takes NEAT's `-teleport <state>` start-up parameter from `CmdParms.txt`
  (`Config.teleport`), so the wiki's Teleport.txt runs as written.

### Hero

```
heroes   (also: herolist)
listallheroes
inn   (also: tavern)
innrefresh   (spends a Hero Hunting you hold)   (also: refreshinn)
hire <hero> | hire best [attack|politics|intel]
findhero atk|pol|int
getspamhero [power|atk | management|pol | stratagem|int]
fire <hero> | firehero <hero string> all
release <prisoner> | releasehero <hero string> all
mayor <hero>   (also: appoint, setmayorbyname)
setmayor att|pol|int | setmayor none|remove
unmayor   (also: unappoint, dischargemayor)
persuadehero <prisoner>   (also: persuade)
rewardheroes
levelup <hero|all> [attack|politics|intel|auto]
uplevelheroes
addpoint <hero> <attack|politics|intel> <n>   (also: addpoints)
renamehero <hero> <new name> [anyway]   (also: changeheroname)
waterhero <hero> [/heropoints="pol:300 att"]
useheroitem <hero> <item> [repeat <n>]   (also: heroitem)
heroitems
waithero <hero string>
waitherolost <hero1,hero2,...>
heroroute
lostheroes
recover <hero> [to <city>]
```

- **`heroes`** lists the city's heroes; **`listallheroes`** every hero in every city as NEAT
  prints them (`CityA Queen Lvl:193 [P:254 A:67 I:21] exp:4737560/3724900`, the lines in
  `$result`). **`inn`** lists the inn; **`innrefresh`** gets a new list, spending a Hero
  Hunting you hold. With none held (or the inventory not loaded) nothing is sent, because
  the server would charge game coins: `buyitem` a Hero Hunting first. (`innrefresh force`
  is gone.)
- **`hire <name> | hire best [attack|politics|intel]`**. **`findhero atk|pol|int`** (also
  power, management, stratagem) hires the inn's best of that kind by base attribute, after
  checking the Feasting Hall has room and the gold is there; `$result` is its name.
  **`getspamhero`** is `hire best`. A hero that asks for jewels (and, for `persuadehero`,
  medals) is taken only while the loaded inventory shows them held: an unknown count is
  none.
- **`fire <hero>`** and **`release <prisoner>`** act on one hero, by name. A hero string
  that picks several (`firehero any:level<50 all`, `releasehero any:level<100 all`) needs
  the closing `all`; `keepheroes` / `keepcapturedheroes` (or their defaults) still protect,
  and `$result` is how many went. `release` frees a prisoner you hold, for good.
- **`mayor <hero>`** (also `appoint`, `setmayorbyname`); **`setmayor att|pol|int`** the hero
  with the most of it (`none` or `remove`: no mayor); **`unmayor`**. The goal engine's
  mayor plan may swap the mayor back on its next tick, as NEAT's does: to make a script's
  mayor stick, set `config hero:0` as a script goal line for as long as needed
  (it also pauses levelling, firing and rewards there), then `loadgoals` to go back.
- **`persuadehero <prisoner>`** asks a prisoner you hold to join: level x 1,000 gold, plus
  the medals it asks for. **`rewardheroes`** gives a gold reward (level x 100 each) to every
  hero under 100 loyalty; `$result` is how many.
- **`levelup <hero|all>`**, **`addpoint <hero> <attribute> <n>`**; **`uplevelheroes`**
  takes every hero here with the experience up one level, less `nolevelheroes`, points by
  `heropoints`, else to its best attribute (it needs `config hero:1` or more when the
  city's goals can be read).
- **`waithero ken`** / **`waithero any:attack>=200`** waits until one is in this city and
  free. **`waitherolost ken,henry`** waits until one of them is no longer yours.
  **`heroroute`** shows where the traininghero goes from each city.
- **`renamehero <hero> <new name>`** (`rename-hero.js`; also `changeheroname`) does what
  the Feasting Hall's Change Name button does, for a hero in any of your cities:
  `renamehero Att66A391 OTTO`. The hero can be given by name, in any case, or by id. The
  game's own rules are checked before anything is sent: no quotes, backslashes or spaces,
  and 10 letters at most (a Chinese character counts as 2). It won't touch a prisoner, and
  it won't guess between two heroes that share a name (rename one by its id). When another
  hero already has the new name, it refuses, because `useheroitem` finds a hero by name and
  takes the first match, so two heroes with one name could get each other's items. Add
  `anyway` to go ahead regardless. Scripts and goals that named the hero by its old name
  need the new name afterwards.
- **`waterhero <hero> [/heropoints="..."]`** (`water-hero.js`) is NEAT's command for Holy
  Water: it resets a hero's attribute points, then spends them again. On its own
  (`waterhero Smarty`) every point goes to the hero's highest stat. After a reset that is
  the stat the hero was born with, so an intel-born hero built into attack comes back an
  intel hero. `/heropoints` takes what a `heropoints` goal takes: `/heropoints="att"` puts
  every point into attack, `/heropoints="pol:300,int:100 att"` brings politics to 300 and
  intel to 100 in proportion and the rest into attack, `/heropoints="pol:300 int:100 att"`
  does them in turn, and `/heropoints=off` leaves the points unspent. A reset costs one Holy
  Water per ten levels begun (`ceil(level / 10)`: 10 for a level 100 hero, 25 for level
  250), which is what the game's own button charges. Nothing is sent for a prisoner, a hero
  that is out (marching, returning, farming or defending), a name two heroes share, or when
  too little Holy Water is held (an inventory that hasn't loaded counts as none); in that
  last case it names any Holy Water packs you could
  open with `useitem`. The points are spent against the stats the reset sends back, never
  the old ones. The Heroes tab's **Reset** button does the same, and shows the cost first.
- **`useheroitem <hero> <item> [repeat <n>]`** (`heroitems.js`): `useheroitem OTTO excalibur
  repeat 5`, `useheroitem OTTO nation medal`, `useheroitem OTTO hero.power.1`. Never on a
  prisoner; `useheroitem <hero> holy water` runs `waterhero`, because the game never resets
  through `hero.useItem`. **`heroitems`** lists the hero items held.
- **`lostheroes`** and **`recover`** (`stone-of-finding.js`) do what the Stone of Finding
  does in the game: it opens a list of heroes you have lost, and restoring one spends a
  stone. A hero captured by the city it attacked is on that list, and comes home with it.
  Don't `release` a captured hero from the captor's side: that loses it. `lostheroes`
  prints the list, with each hero's level, base attributes (points not included), when it
  was lost and its id, plus how many stones you hold. `recover Aldric` restores Aldric into
  the run's city, and `recover Aldric to Second City` into another city. A name is matched
  in any case, and an id always works. Nothing is sent without a stone, or for a name that
  isn't on the list, or for a name two heroes share (it lists both so you can pick by id).
  A dry run reads the list and stops there. When the server refuses and the city's
  Feasting Hall looks full, the refusal says so. `useitem player.item.stoneoffinding` is
  refused and points you to `recover`.

`fire`, `release`, `mayor`, `persuadehero`, `levelup` and `addpoint` act on one hero by
name and refuse `any`: it used to mean the city's first hero, so a slip could fire or
re-spec whichever hero was listed first.

### Account

Items and truces:

```
buyitem [/count=N] <item name or id> [confirm] | buyitem <itemId> [amount]   (more than 100 at once takes confirm; a run buys 100 at most)
useitem [/count=N] <item name or id> [num] | useitem amulet[N]
packages   (also: inventory)
useangelitem <lord> <item>   (Fleet Feet, Endurance of the Immortals, Alchemist's Amplifier; "a lord name" with spaces in quotes)
usedevilitem <x,y> <item> [/close]   (Opportunist's Plague, Lost in the Wastes, Poisoned Feast, Broken Gates)
breakgates <x,y> [/close]
truce
dreamtruce hh:mm[:ss] | dreamtruce hh mm [ss] | dreamtruce /cancel   (server time)
```

- **`buyitem`** buys from the shop, by name or id: `buyitem Ivory Horn`, `buyitem /count=10
  Speaker`, `buyitem <itemId> 5`. It is the one command that spends cents on its own, so
  it is bounded: more than 100 in one order takes `confirm` (`buyitem /count=250 Speaker
  confirm`), one run buys 100 items at most in all (a confirmed order may go past that,
  once), and a bare `repeat` after it is refused.
- **`useitem`** uses an item you hold, by name or id: `useitem Ivory Horn`, `useitem /count=3
  Ivory Horn`, `useitem player.attackinc.1.b 3`; `useitem amulet` the amulet you hold,
  `useitem amulet5` (or `amulet 5`) `player.box.gambling.5`. **NEAT buys what is missing;
  here nothing is bought**: the line fails and says to `buyitem` it. Until the inventory
  has loaded, nothing counts as held (the game would buy a missing item). Teleporters, the
  Stone of Finding, Holy Water, hero items and the items that need a target or a text each
  say which command spends them; `useitem Truce Agreement` is `truce`. **`packages`** (also
  `inventory`) lists the city's packages.
- **`useangelitem Bob Fleet Feet`** uses an angel item on a lord (a name with spaces in
  quotes). **`usedevilitem 111,222 broken gates`** a devil item on a city; **`breakgates
  111,222`** is that Broken Gates, and `/close` shuts the gates instead.
- **`truce`** spends a Truce Agreement for the whole account. **`dreamtruce 10:20`** sets the
  Dream Truce's start, in **server** time: 10 hours truced every 24 while they last
  (`/cancel` ends it). Both ask for the account password, signed with the hash the login
  sent, which only the goals update keeps (`goals/integration`): until it is merged they
  fail and say so.

The lord, quests, reports and logging out:

```
changeflag <flag>   (spends a National Flag; 4 letters at most)
changeplayername <new name> confirm   (spends a New ID; the lord's name changes for good)
resetplayer { unlockcode:"IReallyWantToDeleteThisAccount", player:null }   (deletes the lord; there is no undo)
completequests [routine|daily|title|rank|office] [types] [names] [/mode=] [/type=] [/name=] [/query=available|finished|all]
cleanreports [text[,text...]] | cleanreports trade|army|other
cleannpcreports
logout now <back> | logout <when> <back>   (@:hh:mm[:ss] clock times, or waits: 90, 1:30, 1:05:00)
```

- **`changeflag NEAT`** spends a National Flag (4 letters at most).
  **`changeplayername <name> confirm`** spends a New ID; `confirm` because the lord's name
  changes for good.
- **`resetplayer { unlockcode:"IReallyWantToDeleteThisAccount", player:null }`** deletes the
  lord, with no undo, and takes the console off the game. It is off unless the console
  was started with `OTTO_ALLOW_RESET_PLAYER=1`, the code must be written exactly, and it
  needs the goals update's password hash. NEAT can go on to make a new lord
  (`player:"name"`, city, flag...); here only `player:null` is taken, because a new lord
  needs the game's create-player step (with a captcha), which OTTObot's login doesn't do.
- **`completequests`** claims every finished quest (both tabs when nothing else is given,
  the Routine tab otherwise); `$result` is the list claimed. `title` claims the title
  promotions (Knight to Prinzessin), `rank` or `office` the military ones (Lieutenant to
  General). `/mode=routine|daily`, `/type=a,b`, `/name="a b",c` narrow it; `/query=available
  |finished|all` claims nothing and puts that list in `$result`.
- **`cleanreports barbarian`** deletes every report whose subject or "to" holds one of the
  texts (any case; several with commas); with none, every report. `$result` is how many
  went. OTTObot's `cleanreports trade|army|other` deletes every report of that kind.
  **`cleannpcreports`** deletes the attack and return reports for Barbarian cities, and
  every transport report, from every city.
- **`logout`** (`logout.js`) takes the console off the game. NEAT's forms log out at the
  first time, back at the second, and the **script carries on** from the next line once
  the console is back: `logout 1:00 29:00` (off in a minute, back 29 minutes later),
  `logout @:01:30:31 @:06:35:00`. OTTObot's `logout now @:14:35` or `logout now 1:05:00`
  is the extra-cities recipe's: off now, and the run ends there (nothing may follow it). It
  waits for the other cities' scripts to finish first, blocks every login until the time
  (the maintenance override doesn't lift it), survives a restart, and the console logs
  back in on its own. **Connect** ends it early.

### Social and in-line commands

```
whisper <name> <message>
alliancechat <message>
worldchat <message>   (one Speaker a line)
addfriend <name>   (also: friendadd)
removefriend <name>
block <name>
unblock <name>
```

- **`whisper Bob Hello friend!`**, **`alliancechat …`** and **`worldchat …`** (one Speaker a
  line, the game's rule, 10 s apart). The text goes out as written: NEAT says "expressions
  do not work with this", so build a line with `execute` or put `{expr}` in it, and quote
  a line that holds a link, since `//` starts a comment. A line longer than the chat box's
  150 characters goes out in parts, four at most (world chat refuses it instead: every
  part would cost a Speaker). A line counts as sent when the server says ok or it comes
  back in chat; with neither within 8 s it fails. A line with "cheat" in it is never sent,
  as the game's client never sends one.
- **`addfriend`** (also `friendadd`), **`removefriend`**, **`block`**, **`unblock`**.
- The wiki's PromoAddFriend and SortingMemberList examples run as written.

#### In-line commands

`command "<name> <args>"` in a script, or `\name args` typed in the console's chat box
([below](#the-command-line)). A leading `\`, and the wiki's `!` before a name, are both
fine.

```
accept <name>
alliance <alliance name>
applicants
apply <alliance name>
armyreport [page]
createalliance <name>   (8 characters at most; an Embassy of level 2 and 10,000 gold)
declare <alliance> red|blue|grey|none   (red takes confirm)
expel <name> confirm   (also: eject)
holiday <days> confirm | holiday /exit   (/autoextend is refused: it renews until the coins run out)
invite <name>
invites
join <alliance name>
listallheroes
listcastles x,y x,y [max towns] [min prestige]
listmail [page]
listsentmail [page]
listsystemmail [page]
loc x,y
mail <name> <subject> <text>
members
quickarmyreport [page]
quitalliance confirm
readreport <report id>
resign confirm
searchalliances <name>|* [members|prestige|honor] [page]
searchcastle <alliance | city | lord>
searchenemies <max results>
searchheroes <name>|* lvl|atk|pol|int [page]
sethost <name> confirm
setmember <name>
setofficer <name>
setpresbyter <name>
setvicehost <name> confirm
warreport [page]
who <name>
```

- **Alliance**: `accept`, `alliance`, `applicants`, `apply`, `createalliance` (8 characters
  at most; an Embassy of level 2 and 10,000 gold), `declare`, `expel`/`eject`, `invite`,
  `invites`, `join`, `members`, `quitalliance`, `resign`, `sethost`, `setmember`,
  `setofficer`, `setpresbyter`, `setvicehost`. **Account**: `holiday`. **Reports**:
  `armyreport`, `quickarmyreport`, `readreport`, `warreport`. **Mail**: `listmail`,
  `listsentmail`, `listsystemmail`, `mail` (a subject with spaces in quotes). **Lookups**:
  `listallheroes`, `listcastles`, `loc`, `searchalliances`, `searchcastle`,
  `searchenemies`, `searchheroes`, `who`.
- Their text is shaped as NEAT printed it, so its scripts can split it: `members` is CSV
  with a header line (`"Lord","Position","Prestige","Honor","Last login","Cities","Population"`);
  `who` is `Player info: bob, alliance: X, castle: 1, pres: ..., honor: ..., rank: ...,
  pos: ..., title: ..., pop: ...`. Times are this machine's (`Mon May 23 2011 11:30:01
  PM`), which `date("...")` reads back.
- Leaving the alliance, resigning, handing over the host, making a vice host (who can
  expel members), expelling, declaring war and going on holiday are never one typo away:
  each needs the word `confirm` at the end, and the name must be exact (no `any`, `*` or
  lists). `holiday` also needs the goals update's password hash, and its `/autoextend` is
  refused: it renews the holiday until the coins run out.
- A dry run sends nothing that changes anything. Lookups still read, so `$result` is real;
  opening mail or a report marks it read, so a dry run only lists them.
- None of the alliance, friend, rank or furlough requests had been sent by OTTObot before;
  they are taken from the decompiled client and tested offline, not yet against the server.

### Informational

```
listbuffs
listitems
listmedals
listcommands [word]
scanmap x,y radius | scanmap x1,y1 x2,y2
rescanmap x,y radius | rescanmap x1,y1 x2,y2
scanrec x1,y1 x2,y2
rescanrec x1,y1 x2,y2
findfield <type> <level> <radius> [<hero> <troops>]
find <player name>
get "<http(s) address>" | get "<file>" | get <variable>
```

- **`listbuffs`** (`BUFFS: <what> (expires in 177d:7h:29m:18)`, the account's, then this
  city's), **`listitems`**, **`listmedals`**: `$result` is a list of plain objects, each
  printing as its line. Buffs go live with the goals update (it keeps them current).
- **`listcommands [word]`** every command and its usage, from the running registry.
- **`scanmap x,y radius`** or **`scanmap x1,y1 x2,y2`** (also **`scanrec x1,y1 x2,y2`**) reads
  the map into memory, 20x20 tiles a request through the console's own map reader. A block
  read in the last 30 minutes is not asked again; **`rescanmap`** / **`rescanrec`** read
  every block again, forgetting what was known there first, so a castle that has gone
  drops out. The 16 states are 200x200: Thuringia is `400,200 599,399`. Castles, NPCs and
  flats land in the saved map cache for good; forests, hills and the other valleys stay in
  the console's memory for 30 minutes, so scan shortly before searching them. `$result`:
  `{area, blocks, read, known, failed, castles, npcs, stopped}`. With the console offline a
  scan fails and says so.
- **`findfield npc 5 10`** reads the map around this city and lists each field of that type
  (`castle npc forest desert hill swamp grassland lake flat`) and level (0 = any) within
  the radius, nearest first; `$result` is the field ids. With a hero and troops
  (`findfield hill 10 20 any s:100000`) each line is an `attack x,y <hero> <troops>` line
  with its distance and mission time, and `execute $result` sends them. Valley owners are
  not checked (NEAT's neither).
- **`get "https://…"`** fetches a web page (a battle log: `report = xml($result)`); **`get
  "Items.txt"`** a file in the console's scripts folder. With no such file,
  `NewCityGoals.txt`, `PrependGoals.txt` and `AppendGoals.txt` are the account's goal texts,
  so NEAT's NewCityScript runs. Addresses on the public internet only. Quote an address:
  `//` starts a comment.
- **`find <player name>`** lists that player's castles from the saved map cache.

### Goals in scripts

NEAT: "Any goal can be used in the script window."

```
goal <goal line> | goal <expression whose text holds goal lines>
config <key>:<value>[,<key>:<value>...]
buildinggoals <build goal>
techgoals <research goal>
loadgoals [goal set 1-9 | city name | castle id]   (none or 0: back to the saved goals)
resetgoals
```

```
config npc:5,comfort:1             config switches
troop a:5000 | fortification ab:1k | hiding 2     any goal line on its own
goal build c:10:9                  any goal line, said explicitly
goal $result                       every line of an expression's text is a goal line
buildinggoals st:0:0,b:9:12        = goal build st:0:0,b:9:12
techgoals ar:10,ho:10,mt:9         = goal research ...
loadgoals 3 | loadgoals Fla | loadgoals 12345     goal set 3, or that city's saved goals, in place of this city's
loadgoals | loadgoals 0            back to the city's saved goals
resetgoals                         no goals in this city; goal lines after it build a fresh set
```

A line whose first word is a goal and no script command is a goal line: `troop a:5000`
sets a troop goal, `build c:10:9` a build goal and `research lo:5` a research goal, while
`build cottage` stays the immediate command. They change the goals the engine **runs** in
the run's city, never the saved ones: a script layer per account and city, kept in
memory, until a script changes it again, the city's goals are saved, **Clear script
goals** is pressed, or the console restarts. `$result` is the layer (`echo $result`
prints a summary); `$error` is what the goals could not take. NEAT's NewCityScript runs:

```
@get "NewCityGoals.txt"
if $error == null goal $result
```

A goal line for a goal OTTObot doesn't have (`tradepolicy`, `keepresources`,
`valleyheroes`, `config abandon`) is refused like any other bad line. Goal lines need the
goals update's goal layer (`goallayers.js`, on `goals/integration`). Until it is merged,
every goal line fails, clearly, and the script goes on.

## Objects and functions

### Objects

Everything a script reads is a **copy** built on each read: `city.troop.archer = 5` or
`cities.pop()` changes only the copy. The names are the Evony client's own bean fields,
typos included (`texRate`, `storeRercent`, `upgradeing`, `permition`, `scouter`,
`heavyCavalry`), because NEAT scripts read those beans. Members marked * need a server
read; they are cached a few seconds and the language waits for them.

```
city = m_city = m_city.cityManager         the run's city
  id name fieldId x y coords cityCoords timeSlot cityNameCoords() castle
  script.callScript("lines")               start those lines in another city (below)
  resource estResource resetEstResource() reservedResource ResourceProduction* incomingResources([sec])
  hasResource(res)                         at least these held (a bean or "f:1m,g:5k")
  troop troops troopStillInProduction* getAvailableTroop([inCityOnly]) getCarryingLoad(troops)*
  getTravelTime(fromFid, toFid, troops[, type])*
  fortification fortificationsRequirement fortificationRequirement fortificationProduceQueue*
  buildings getBuildingLevel(t) getBuildingByTypeId(t) getBuildingByPosId(p) countBuilding(t[, min[, max]])
  hasBuilding(t[, min]) getTownHallLevel() getWallLevel() getActiveBuilding() getEmptyPositions(t)
  rallySpotAvailable([reserveForTrainingHero[, extra]])
  researches* getTechLevel(t)* GetTechLevel(t)* hasTech(t, lvl)* getActiveResearch()* is_researching*
  heroes innHeroes* findHeroByName(n) heros(n) getMayor() IsHeroInCastle(s) AnyIdleHero(s)
  trainingHeroName TrainingHeroIsHere checkFeastingHallSpace
  enemyArmies friendlyArmies selfArmies myArmies hasEnemyArmies hasEnemyArmiesWithin(sec[, blind]) NumberOfRealAttacks
  fields tradesArray transingTradesArray buyPrice(res) sellPrice(res)
  buffs hasBuff(t) buff(t) brokenGates
  PRFactor comfortingNeeds(1-4) getConfig(key) CityHasGoalErrors GateControl
  compareByDistanceToCastle(a, b) setCityTimer(key) cityTimingAllowed(key, sec[, test])
cities[i].cityManager                      every city, in login order (the same view)
player = m_context.Player                  the PlayerBean: playerInfo, friends, blocked...
m_context   truced inTruceCooldown hasBuff(t) buff(t) buffs ItemCount(id) GetItem(id)
            marketReady() buyPrice(res) sellPrice(res) findFirstCity()
            serverHours serverMinutes serverSeconds serverYear serverMonth(0-11) serverDate maintenanceStart
Screen.mainLog | cityLog | reportLog | aChat | pChat | wChat | sChat   .buffer   .addEvent("text")
Config.<key>                               the server, the proxy, and CmdParms.txt's -name value pairs
                                           (Config.teleport is -teleport; pass/secret/token keys left out)
Settings.autoUseItems(...)                 NEAT's list of items it uses by itself: none here, and it says so
GetTroops("a:30k,b:40k")  TroopBeanToString(bean[, sep])  GetFortifications(str)
ItemCount(idOrName)  GetItem(idOrName)  IsHeroInCastle(heroString)  AnyIdleHero(heroString)
GetTechLevel(type)  is_researching  HeroLevel(level, exp)  HeroExperience(end[, start[, exp]])
```

The beans in those lists:

```
hero     the HeroBean's fields, plus base expLevels buffsArray isIdle isMayor isDefending isMarching
         isCaptured isReturning isBusy isAvailable isLoyal isAttackHero isPoliticsHero isIntelHero
         powerWithBuffAdded managementWithBuffAdded stratagemWithBuffAdded
army     the ArmyBean's fields, plus hero (its name) resource troop startCoords targetCoords
field    id level name statu type x y coords armysArray
troops   the 12 troop keys, foodConsumeRate foodConsumption(sec) add(x) addTo(x) toString(sep)
resource gold food wood stone iron  add(x) addTo(x) toString(sep)
building / research / buff / item    the client's beans ({name, positionId, level, status...})
```

`IsHeroInCastle` and `AnyIdleHero` take NEAT's unquoted hero strings:
`if m_city.AnyIdleHero(any:att>100,att<300) …`. Strings round-trip:
`GetTroops(TroopBeanToString(b, ","))` gives `b` back. A map bean from `GetDetailInfo`
carries `canScout` (the server's flag when the details brought it, else an NPC or
another lord's castle at peace).

`cities[x].cityManager.script.callScript("levy 1 \n echo city.resource.support")` starts
those lines as that other city's own run, beside this one (its Output shows it, its Stop
ends it). The lines are checked first, a city that already has a run is not disturbed, and
a dry run starts a dry run. Only the console can start one; anywhere else the line fails
and says why.

### Functions and constants

```
Math       abs acos asin atan atan2 ceil cos exp floor log pow sin sqrt tan random()
           round(n[, places])  max(a, b, ...)  min(a, b, ...)  isNaN isFinite
           parseInt parseFloat Number String Math.<any of these>  PI E SQRT2 LN2 LN10 NaN Infinity ...
Strings    CenterPad / LeftPad / RightPad(str, length[, pad])  StringRepeat(count[, str])
           Merge(a, b[, delim])  Upper1(str)  StringToObject(str, delim1, delim2[, into])  ToCSV(...)
           FormatNumber(n[, places[, commas]])  FormatNumber2(n)  FormatPercent(n[, places])  FormatMiles(n)
Parsing    ParseInteger(text, min[, max[, suffix]])  PrepareParameters(text)  GetResources("f:1m,g:10k")
Time       date() | date(ms) | date(y, month0, d[, h, mi, s, ms])  TimeDiff(t[, from])
JSON, XML  json_encode(v[, indent])  json_decode(text)  xml(text)
           GetTroopsFromXML(list[, countProp])  GetFortsFromXML(list[, countProp])  GetResourcesFromXML(node)
Map        GetFieldId("x,y" | x, y)  FieldIdToCoords(id)  GetX GetY GetLevel GetType GetZoneName(id)
           GetFieldType(name)  GetFieldName(type)  MapDistance(x1, y1, x2, y2)  FormatDistance(id1, id2)
           StateCoords(state | 0-15 | "all")  StateName(n)  FindField(x, y, radius, type[, level])
           CastlesInRectangle(x1, y1, x2, y2[, omitNpc[, byId]])  AllCastles(id1, id2[, omitNpc])
           MapCastles(x, y, radius)  SearchEnemyCastles([n])  GetDetailInfo(id[, ...])  UpdateDetailInfo(id)
           RelationIndex(bean)  ResetMap(x, y, radius | width, height)  getTravelTime(id1, id2, troops, type)
Timers     setCityTimer(key)  cityTimingAllowed(key, seconds[, test])
Market     BuyPrice  SellPrice  Price  MAX_TRADE  ResourceIntNames          (above)
Language   CreateFunction(args, body)
Constants  BuildVersion BuildDate BuildName  RESOURCETYPE_FOOD/WOOD/STONE/IRON  ResourceNames
           BuildingTypes ResearchTypes FieldTypes PlayerState Abbreviations SpeedUpItems
```

The map functions read the console's live map blocks (fresh for 30 minutes) laid over the
saved map cache, and work offline. Valleys are known only from live blocks, so scan first.
`GetDetailInfo` asks the server for a castle's details once and caches them per account.
`BuildVersion` is 9999, so NEAT's version checks (`if BuildVersion < "3163" …`) pass;
`BuildName` and `BuildDate` say OTTObot.

## The console

### Run at a line, Stop and Resume

The box beside **Run** is NEAT's Run box: a line number or a label to start at (empty or 0
is line 1). A number past the last line, or a label the script doesn't have, is refused
and nothing runs.

**Stop** ends the run once the line it is on finishes, and cuts any wait short. A script
paused at a `stop` line shows **Resume**, which carries on from the line after it; Stop
ends it instead. The Output tab says which line it is paused at.

A Run is one long request from the page. When the console restarts under it, the browser
sends it again; each Run carries an id, and one already started is refused ("press Run to
start it anew"), so a restart never runs a script twice. A live run without an id is not
started at all (so the old `/script` page only dry-runs). Runs are kept by the city's
castle id, however the city was named, so one city never has two.

### `call`

`call` runs another script, looked for in this order: a loadout of the run's city by slot
(`call 3`, `call load3`, `call "Load 3"`), a loadout by the name on its first line, then a
file in the console's scripts folder (`<repo>\scripts`, `call "UseItems.txt"`, `call
sub/items.txt`, `.txt` added when no extension is given). Never a URL, a full path or a
`..`; no part of the name may be a link or junction, and a file over 1 MB is refused. The
called script is checked like any other: one with an error isn't run. `get` reads files
from the same folder.

### Autorun and start-up parameters

NEAT's autorun, **off until you switch it on** with `AUTOSCRIPTS=1`, or NEAT's own
`-autoscripts 1` in `CmdParms.txt`. Then, once the console has logged in after a start
(never again on a reconnect), every city runs its **startup file**, then each **saved
loadout holding `label autorun`**, from that label, one after another. The cities run side
by side. A city that already has a run is left alone. The Log tab says what started, and
how each ended, with the first failed line. Autorun's last start is kept per account, and
a console that starts again within 10 minutes (a crash loop, another session restarting
it) skips it.

- The startup file is `RUNSCRIPT` (NEAT's `-runscript`) from the scripts folder, else
  `AutoRunScript.txt` when it is there.
- The switches may sit in `<repo>\CmdParms.txt` as NEAT writes them (`-autoscripts 1`,
  `-runscript Items.txt`, also `-name=value`); the environment wins over the file. Every
  `-name value` there also reaches scripts as `Config.<name>`: `-teleport tuscany` is
  `Config.teleport`, which `autoteleport` with no state uses. Keys that look like
  passwords, secrets or tokens are left out.
- Auto-login and running the goals are always on; NEAT's minimize switches don't apply.
- The loadout list marks a loadout that holds `label autorun`, and Save says it starts by
  itself (when autorun is switched on).

| variable | what it does |
|---|---|
| `AUTOSCRIPTS` | `1` (or yes/on/true) switches autorun on; anything else, or unset, leaves it off |
| `RUNSCRIPT` | the startup file every city runs first |
| `EVONY_SCRIPTS_DIR` | where `call`, `get` and the startup file are read (default `<repo>\scripts`) |
| `EVONY_MEDIA_DIR` | where `play` finds sounds (default `<repo>\media`) |
| `EVONY_CMDPARMS` | NEAT's parameter file (default `<repo>\CmdParms.txt`): its `-autoscripts` and `-runscript`, and `Config.<name>` for scripts |
| `OTTO_ALLOW_RESET_PLAYER` | `1` lets `resetplayer` run at all |
| `OTTO_ALLOW_ABANDON_TOWN` | `1` lets `abandontown` run at all (buildnpc's throwaway cities only) |

`scripts\`, `media\` and `CmdParms.txt` are each install's own and are gitignored.

### `say` and `play`

A script's `say` and `play` go to every open console tab. One tab per browser acts on each:
it speaks with the browser's voice (in the language named, when the browser has that
voice) or plays the sound, and the editor hint shows what was said or played and from
which city and line. A browser allows sound only once the page has been clicked, so until
then the hint says what wasn't heard. Sounds come from the media folder
(`/api/script/media`), or a link.

### The command line

A line typed in the chat box that starts with `\` runs an in-line command in the open city
(`\who Bob`, `\members`, `\searchheroes * atk`), as a script's `command "who Bob"` does. Its
output goes to the Output tab; nothing is sent as chat.

## Safety switches and refusals

**Money: no cents outside `buyitem`.** `buyitem` is the one command that spends cents on
its own, and it is bounded: more than 100 in one order takes `confirm`, one run buys 100
items at most (a confirmed order may go past that, once), and a bare `repeat` after it is
refused when the script loads. `useitem` never buys a missing item. **An item counts as
held only while the loaded inventory shows it**, and an inventory that hasn't loaded yet
counts as none: `useitem`, `waterhero`'s Holy Water, the teleporters, `/big`'s War Ensigns
(counted down as a run uses them), speed-up items, Dynamite, and the jewels and medals
`hire`, `findhero` and `persuadehero` hand over. The game would buy any of them that is
missing. Speeding up with coins is off: `ALLOW_COINS_SPEEDUP = false` in
`script-cmd-city.js` refuses `/speedup=coins`, `buildingspeedup coins` and
`researchspeedup coins` when the script loads. `innrefresh` never pays coins (there is no
`force`: `buyitem` a Hero Hunting), and `holiday /autoextend` is refused. `worldchat` costs
a Speaker a line, and a long line is refused rather than split.

**Nothing irreversible is one typo away.**

| line | needs |
|---|---|
| `abandontown <city>` | `OTTO_ALLOW_ABANDON_TOWN=1` at console start, a city the goal engine's registry marks abandonable (buildnpc's; no registry row = refused), not the last city, `confirm`, `anyway` while heroes, troops or marches would be lost, the goals update's password hash (its SHA1, as the client sends) |
| `demo`, `demosite`, `walldefense` on the Town Hall or the Walls | never, with or without `/dynamite` |
| `autoteleport … all` | `confirm` |
| `evacuatetown x,y` | `confirm` |
| `changeplayername <name>` | `confirm` |
| `resetplayer {...}` | `OTTO_ALLOW_RESET_PLAYER=1` at console start (a fetched or called script can't set it), the exact unlock code, the goals update's password hash |
| `buyitem` over 100 | `confirm`; 100 items a run at most otherwise |
| in-line `expel`, `quitalliance`, `resign`, `sethost`, `setvicehost`, `declare … red`, `holiday` | `confirm`, and an exact name |
| `fire` / `release` of several heroes | a hero string and the closing `all`; keepheroes still protect |
| `fire`, `release`, `mayor`, `levelup`, `addpoint`, `persuadehero` | a name: `any` is refused |
| `innrefresh` with no Hero Hunting | not sent: `buyitem` one first |

**Runaway runs.** A line the server refused waits 200 ms before it is sent again, and its
10th refusal in a row ends the run. Background attacks: one of each kind per target and
city, 10 per console, and `capture` / `loyaltyattack` stop after 100 waves, 12 hours or 3
unreadable reports in a row unless the line says `/waves=N` or `/hours=N`. Autorun is off
until switched on, and skipped when the console restarts within 10 minutes. A dry run of
`holidaysnipe stop` leaves the sniper running. A live run needs the Script tab's run id, so
a browser re-send or the old `/script` page cannot start one.

**Heroes.** A march takes only an idle hero of the city: never one that is out, the mayor,
a prisoner, or one this script sent in the last minute. `release` frees prisoners only.
`useitem` of the Stone of Finding, teleporters or Holy Water points to `recover`,
`teleport` and `waterhero`.

**The network.** `get` and `post` reach addresses on the public internet only
(`script-net.js`): an address is checked on the URL, on every name lookup and on every
redirect, and every way of writing this machine or its networks is caught. `post` may reach
localhost and private networks only on a console bound to loopback. Link-local addresses
(cloud metadata) never pass. `call` never fetches a URL.

**Files.** `call`, `get` and `play` read only inside `<repo>\scripts` and `<repo>\media`:
no URL, full path, `..`, link or junction, or device name. A script file over 1 MB and a
sound over 20 MB are refused.

**The language.** No `eval`, `new Function` or `vm`: `__proto__`, `prototype` and
`constructor` are never read or written, and scripts only hold copies of game state.
Regexes run in a worker with a 2-second limit and a 1,000,000-character cap.

**The market.** A price over 150, an order over 99,999,999, or extra words on a buy or sell
line are refused. Writes are paced.

**Chat.** A line with "cheat" in it is never sent.

## Differences from NEAT

**Measured.** Every Usage, Example and code line on the NEAT wiki's script pages (2,249
lines from 206 pages) has been put through the language, and `test-script-compat.js`
runs the example scripts end to end against a fake world, checked word for word against
the wiki: AbandonAllValleys, AutoTeleporter, MonitorCity, PeacetimeStatusChecker,
PromoAddFriend, SortingMemberList, the STS trader, Travelinfo, TroopAndResourceTotals,
NewCityScript, AutoRunScript and every Scr1ptingForDummies snippet. 1,884 lines parse and
none fails unexplained. The rest are usage templates, output or prose shown on the page,
lines refused on purpose (the `confirm` words, coins, items never bought, the switches
above), goal lines for goals OTTObot doesn't have, and the few things under
[not done](#not-done).

What a NEAT operator will notice:

- **A script with any error is refused whole**, before anything is sent. NEAT reports a bad
  line when it gets to it (the Execute page's "Label 'city.timeSlot' not found"). Lines
  built at run time fail here too only when they run, and set `$error`.
- **`repeat N` and `loop N` count in total**, as NEAT means them. OTTObot's own old
  `repeat N` meant N more times: old loadouts do one fewer.
- **`useitem` never buys.** NEAT buys a missing item; here the line fails and says to
  `buyitem` it. Nothing spends cents except `buyitem` (capped at 100 items a run without
  `confirm`): no `innrefresh force`, no `holiday /autoextend`, no coins speed-ups, and an
  item counts as held only once the inventory has loaded.
- **Autorun is off until switched on** (`AUTOSCRIPTS=1`, or `-autoscripts 1` in
  `CmdParms.txt`), and a console that restarts within 10 minutes skips it.
- **A line the server keeps refusing ends the run** on its 10th refusal in a row (each
  retry waits 200 ms); NEAT would go on.
- **The Town Hall and the Walls are never demolished**, by `demo`, `demosite` or
  `walldefense`, as the game's own client offers no Destruct for them.
- **`exit` never closes the console**; it is `end`. `stop` pauses until Resume.
- **`@hh:mm:ss` on a march is camp time**, as in NEAT; `@:hh:mm:ss` lands the march, to the
  millisecond, with recall and resend of a miss (NEAT lands to the second).
- **`build c:10:9` is the build goal**; `build cottage [at N]` is OTTObot's immediate build,
  and NEAT's immediate one is `create`. `research lo:5` is the research goal; `research
  <tech>` and `startresearch` are immediate.
- **`$error` is `null` after a line that worked.**
- **Hero strings**: only idle heroes go; `any` on an attack takes the strongest attack hero.
  One-hero commands refuse `any`, and `firehero` / `releasehero` of several need `all`.
- **`call` doesn't fetch URLs**: save the script as a loadout or a file in `<repo>\scripts`.
- **`say` and `play`** sound in an open console tab, not on the bot's PC.
- **Chat, alliance, friend and furlough requests** are live-unverified (see
  [in-line commands](#in-line-commands)).
- **`truce`, `dreamtruce`, `holiday`, `resetplayer`** need the goals update's password hash;
  **goal lines** need its goal layer; **buffs** (`listbuffs`, `hasBuff`, `truced`,
  `brokenGates`) go live with it.
- **`resetplayer`** only deletes (`player:null`); NEAT can go on to make a new lord.
  **`abandontown`** gives up only buildnpc's throwaway cities, with its own switch.
  **`buyitem`** is capped at 100 items a run without `confirm`.
- **`waitherolost`** can't tell a captured hero from a dismissed one: a hero missing for
  10 s counts as lost.
- **`loyaltyattack`** needs an existing scout report of the target to start from.
- **Background attacks** don't survive a console restart, run one of each kind per target
  and city (10 per console), and `capture` / `loyaltyattack` stop after 100 waves or 12 hours
  unless `/waves=N` / `/hours=N` say otherwise.
- **`production`, `comfort`, `tax`, `levy`** act once; their goal halves are the goals'.
  `buildcity` has no ValleyTroops goal (troops by the flat's level). `evacuatetown` is one
  march.
- **`autoteleport … all`** and the in-line `setvicehost` take `confirm`.
- **Valleys scanned** stay in memory for 30 minutes; only castles, NPCs and flats are saved.
- **Objects are copies**, built from an allowlist of the client's bean fields.
  `player.playerInfo.accountName` (the login e-mail) and `Config.username/password` are left
  out on purpose.
- **`BuildVersion` is 9999**, so version checks pass; `BuildName` and `BuildDate` say OTTObot.
- **Speeding up with coins is off**, and speed-up items are used only when held.

### Not done

- Object members NEAT has and OTTObot has no data for: `getMaxArmySize`,
  `hasResourceForArmy`, `haunted`, `distanceSettings`, `buildings[0..73]` in NEAT's order
  (here the server's), `Screen.bChat`, `Screen.commandLog`, `getArmyTravelTime`,
  `getFoodConsume`, and NEAT's internals (`innStatus`, `troopQueueStatus`,
  `buildCityLocations`, `debugMask`). `estResource` is the last push, not extrapolated.
- `Settings.autoUseItems(...)`: OTTObot keeps no list of items it uses by itself.
- `MapColors` (the map view's colours).
- Editor colouring: the server gives each line's standing (`/api/script` with
  `parseOnly`); the colours come with the goals update's editor.
- `ParseInteger("40", 50)` returns -1 here (40 is under the minimum), where the wiki's
  example shows 40.

### Where the wiki's own examples are wrong

Pasting these as they stand gives what the code says, not what the page shows: the Arrays
page's multi-dimensional results disagree with its own code; CreateFunction's `every`
limit string has a typo (`i:10m:10m`); Unsorted 2650 leaves out `label continue`; Unsorted
2629's Example 3 never leaves its loop; and the Execute, JSON and Unsorted snippets lean on
lines from elsewhere on their pages.
