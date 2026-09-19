# Game Direction

## Confirmed foundation

- A 2.5D isometric role-playing game in a steampunk-inspired world.
- Quests that give the player reasons to explore and interact with the world.
- NPCs to meet, speak with, and encounter throughout the adventure.
- Puzzles as part of exploration and quest progression.
- Turn-based combat.
- Visual direction based on the user's supplied industrial steampunk references, rendered smoothly without pixelation; see [ART_DIRECTION.md](ART_DIRECTION.md).

The sections below are an initial design proposal, open to revision. They describe intended gameplay, not implemented features.

## World and atmosphere

An inhabited industrial world of riveted iron, copper pipes, brass machinery, amber gas lamps, and blue-green electrical glows. Steam technology shapes everyday life, transport, work, and local conflicts. Workshops, canal streets, boiler houses, and clock towers provide varied places to explore.

Follow the stylized fantasy steampunk direction established in CODEX.md and ART_DIRECTION.md, with bold shapes and painterly surfaces. Give the world warmth through its inhabitants, homes, and gathering places.

## Gameplay loop

Explore a district, meet its inhabitants, discover a problem, and follow clues. Progress through dialogue, mechanical puzzles, and turn-based encounters. Return to the people affected to resolve the quest and see its consequences.

Exploration uses free movement. Combat switches to discrete turns with readable movement ranges and action choices; exploration resumes after the encounter.

## Quests and NPCs

Give important NPCs a practical role, a personal motivation, and a connection to the surrounding community. Engineers, couriers, merchants, workers, and officials can disagree about how the city's machines should be used.

Track quest objectives and discoveries in a journal. Where scope permits, let conversations and puzzle solutions provide alternatives to fighting. Start with authored dialogue and a small number of meaningful choices.

## Puzzles

Build puzzles around understandable machinery: routing steam, arranging gears, restoring power, and operating valves in the correct sequence. Teach each mechanism through a simple interaction before combining it with others.

Provide clear visual feedback and allow puzzles to reset so experimentation cannot permanently block a required quest.

## Turn-based combat

Initial proposal: small tactical encounters on a grid aligned with the isometric world. Show turn order, movement range, valid targets, and expected effects before the player commits.

Begin with movement, a basic attack, a defensive action, and one mechanical ability. Use a small set of distinct enemies and environmental interactions, such as a valve that releases steam into marked tiles.

Party size, character progression, action costs, and the final initiative system remain undecided. Avoid building large systems before a single encounter feels good to play.

## First playable slice: The Silent Pump

A neighborhood's steam-powered water pump has stopped working. A local mechanic asks the player to investigate the nearby pump house.

- One compact district and an accessible pump-house interior.
- Three NPCs: the mechanic, a resident affected by the outage, and a maintenance worker with a useful clue.
- One quest connecting conversations, exploration, and the repair.
- One steam-routing puzzle with clear pressure indicators.
- One short turn-based encounter with malfunctioning maintenance automatons.
- A visible resolution: the pump restarts, the journal updates, and NPC dialogue reflects the repair.

This slice should establish the full gameplay loop before adding more districts, quests, enemy types, or progression systems.
