# Ten Candles – Tisch

A Foundry VTT module that turns [Ten Candles](https://cavalrygames.com) into a candlelit table for groups playing
online: ten tealights burning down in real time, everyone's camera around the tray, cards that are written, passed
and burned in front of the players, the final recordings, and the X-card always within reach.

It is built on top of the [Ten Candles – Game Assistant](https://github.com/ctotone/tencandles-ga) system, which keeps
the rules (dice pools, conflicts, Moments, the ritual of truths). This module adds the table around it: what the
players see and hear, and the parts of the game that happen at the table rather than on a character sheet.

The interface is in German and English.

## Requirements

- Foundry VTT v14.
- The game system **Ten Candles – Game Assistant** (`tencandles-ga`), version 1.0.1 or later.
- Foundry's audio/video set to **video only** is recommended; voice runs best in a separate app (e.g. Discord).

## Installation

Install the module from its manifest URL (Foundry: *Add-on Modules → Install Module*; The Forge: *Bazaar → Install
From Manifest*):

```
https://github.com/Vinai/ten-candles-foundry/releases/latest/download/module.json
```

Then enable it in a world that uses the Game Assistant system.

## What it does

**The table.** The Game Assistant's tray painting fills the screen: ten animated tealights, each with its own
flickering light, and a bowl in the middle. Every player sits at the bottom of their own screen and sees the others
clockwise around the tray, their camera feeds fading into the dark. Each player's stack of cards lies in front of
them; you see your own, the GM sees all. The GM's Game Assistant cards (conflicts, Moments, truths) appear over the
bowl in a pool of light, so nobody needs the chat.

**Character creation.** The GM leads the rulebook's steps one button at a time: Virtues and Vices are written and
passed to the right and left, Moments are written and kept, Brinks are written and passed face down. Candles are lit
three at a time with a struck match; the tenth is lit at *Lights out*. Cards can be picked up and changed until they
are passed; *Step back* undoes a step. Players arrange their stack in the character sheet, where only the top card is
active.

**Playing.** From *Lights out* the candles burn down in real time (3 to 3½ hours each, guttering before they die).
Rolled dice tumble across the tray as 3D cubes with their sound; a 1 shows a skull. A trait burned for a reroll burns
in the bowl before the 1s are rolled again. Every candle that goes out — by a failed conflict, burning down or the
GM's *Draught* — brings "These things are true. The world is dark." and the truths, with the speaking order on the
GM's card, until the GM's *And we are alive.*

**Moments.** A player asks to live their Moment from their sheet; the GM decides whether the situation fits. If it
does, the player's conflict roll starts by itself, and its result decides whether hope is found.

**Death.** The GM marks characters who have died; their face turns black and white like an old television, they no
longer roll or speak truths, and a Martyr may pass on their hope die.

**The end.** A dictaphone travels round the table for the final messages, recorded in the browser and stored by the
GM's browser (no upload rights needed for players). When the last candle goes out, the room turns black, the GM's last
words stay, and the messages are played one by one in every browser.

**Safety and fallback.** The X-card lies on the table for everyone; touching it is shown to all, without a name. Any
player can switch to a *plain table* (Configure Settings) that keeps Foundry's own scene and camera dock, for weak
machines or when something goes wrong; writing cards, the recorder and the X-card still work there.

## The GM panel

Seating · the next character-creation step · Step back · Lights out / Lights on · Pause / Resume · Draught · And we
are alive. · The dead · Switch recorder on / Pass recorder on / Restart recorder · Next recording

## How it works with the Game Assistant

The module uses only the Game Assistant's settings, hooks, socket API and rendered chat cards; it contains none of its
code or assets. The tray painting is loaded at runtime from the installed system. Some of the Game Assistant's
German texts are overridden in this module's language file, and its chat cards are trimmed for the table in each
browser; the stored messages stay as they are.

## Development

No Node toolchain is needed. A local Foundry runs in Docker (`compose.yml`) with `module/` mounted into its data
folder; reload the browser to pick up changes. Releases are built by GitHub Actions from a tag:

```
git tag vX.Y.Z && git push origin vX.Y.Z
```

## Credits and licence

The module's code is under the [MIT licence](LICENSE).

- Fonts: Special Elite (Apache 2.0) and Caveat (SIL Open Font License 1.1), see `module/fonts/CREDITS.md`.
- Sounds: recordings from Freesound, dedicated to the public domain (CC0), see `module/sounds/CREDITS.md`.

*Ten Candles* is written by Stephen Dewey and published by Cavalry Games. This module is a fan project, not affiliated
with Cavalry Games or with the authors of the Game Assistant system, and it contains no text from the rulebook.
