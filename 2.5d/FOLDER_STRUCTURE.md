# Project folders

All paths below are relative to this Godot project's root (`res://`).

| Folder | Contents |
| --- | --- |
| `assets/models/environment/` | Imported walls, floors, bridges, and other architecture |
| `assets/models/props/` | Imported lanterns, pipes, valves, boilers, and containers |
| `assets/models/characters/` | Imported player, NPC, and enemy models and animations |
| `assets/textures/` | External image textures and material maps |
| `assets/materials/` | Reusable Godot material resources |
| `assets/audio/music/` | Music tracks |
| `assets/audio/sfx/` | Sound effects and ambient loops |
| `assets/ui/` | Interface artwork, icons, and fonts |
| `scripts/core/` | Movement, camera, and shared game systems |
| `scripts/mechanics/` | Puzzles, valves, interactions, and environmental mechanics |
| `scripts/quests/` | Quest tracking and progression logic |
| `scripts/dialogue/` | NPC conversation logic |
| `scripts/combat/` | Turn order, combat actions, and targeting |
| `scripts/ui/` | Interface behavior |
| `scenes/levels/` | Playable locations, including The Silent Pump |
| `scenes/props/` | Reusable props with collisions and interaction setup |
| `scenes/characters/` | Player, NPC, and enemy scenes |
| `scenes/ui/` | Menus, journal, dialogue, and combat interface scenes |
| `data/quests/` | Quest definitions |
| `data/dialogue/` | Conversation content |
| `data/items/` | Item definitions |
| `data/combat/` | Ability and combat configuration resources |
| `shaders/` | Water, visual effects, and other custom shaders |

Use lowercase snake_case for new asset and scene filenames. For a multi-file model export, keep the model and its accompanying files together in a named subfolder so relative texture paths remain intact.

The existing `Addons/` directory is preserved. Concept images and Tripo reference images remain in the repository's `assets/references/` folder outside this Godot project. `.gitkeep` files retain empty project directories in version control.
