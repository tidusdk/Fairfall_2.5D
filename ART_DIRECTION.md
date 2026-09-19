# Art Direction

## Approved visual foundation

The user supplied four images as references for the desired look, with the explicit requirement that the game should not be pixelated. Use their visual content as reference material. The rendering and gameplay adaptations below are implementation guidance, not a claim that the source images are production assets.

Target: stylized fantasy steampunk with bold silhouettes, exaggerated proportions, softly beveled shapes, and hand-painted-looking materials, viewed through the game's established 2.5D isometric camera. The user's latest preference supersedes the earlier realism direction. Keep the non-pixelated presentation.

The initial scene concept and six images in assets/references/tripo-starter represent the earlier realistic exploration. Keep them for shape and subject reference; they are no longer the target surface treatment. New fantasy variants should use separate filenames.

## Fantasy shape language

- Oversized lantern housings, chunky pipe collars, large rivets, and broad readable valve wheels.
- Gently bowed profiles and charming asymmetry for individual props; modular joining surfaces remain straight and consistent.
- Large rounded masonry blocks with selective chips rather than dense cracks.
- Painterly color gradients, broad highlights, and deliberate edge accents instead of photographic rust, scratches, or surface noise.
- Rich amber, honey-gold brass, deep blue-grey iron, and turquoise accents; preserve atmospheric contrast without muddying the colors.
- Convey fantasy through shapes and color first. Magical technology and lore remain optional, not established gameplay requirements.

## Reference roles

| Reference file | Qualities to carry forward |
| --- | --- |
| `D:/game_research/assets/foreground-props.png` | Brass-trimmed lanterns, riveted pipe fittings, valves, boilers, control panels, chains, and sturdy containers; strong individual silhouettes and amber or cyan light accents. |
| `D:/game_research/assets/piston-sinks-platform.png` | Damp stone paving, substantial masonry foundations, embedded grates, metal corner braces, and pipes integrated into platform edges. |
| `D:/game_research/assets/sewer-toxic-view-v1.png` | Layered brick arches, large valve pipes, suspended machinery, stained masonry, green effluent, and atmospheric depth in hazardous underground areas. |
| `D:/game_research/assets/piston-sinks-background.png` | Monumental piston towers, stacked bridges and walkways, canals, steam plumes, warm windows, and teal water beneath dense industrial architecture. |

The magenta fields in the prop and platform references are asset-sheet backgrounds, not part of the world palette. The scene references establish architecture and atmosphere; their viewpoints do not change the established isometric gameplay direction.

## Materials and palette

- Dark charcoal iron and damp grey-brown masonry form the base.
- Aged brass and copper define fittings, rims, valves, and mechanical details.
- Amber lamps and windows provide warm focal points.
- Teal and cyan water, glass, and machinery provide cool accents.
- Yellow-green sludge belongs to polluted or hazardous locations rather than every district.
- Suggest wear with a few painted soot marks, turquoise patina patches, and broad edge accents. Keep large surfaces clean and readable.

## Translating the references without pixelation

Use smooth geometry, anti-aliased edges, continuous lighting gradients, and textures that remain clear at the intended camera distance. Curved pipes, lantern housings, and gears should retain rounded contours. Geometry can be optimized without exposing coarse facets.

Use simplified material response, painted gradients, and broad restrained reflections. Avoid photographic surface relief, tiny high-contrast speckles, dense tarnish, and realistic microdetail. Group detail into readable surfaces so the scene stays coherent during camera movement.

Use soft steam, restrained glow, contact shadows, and atmospheric depth. Preserve dark mood while keeping traversable surfaces, characters, and interactable mechanisms visible.

## Composition and gameplay readability

Build scenes from substantial stone platforms and arches, then integrate pipes, pistons, railings, lamps, and machinery. Use overlapping structures and distant silhouettes to imply a large inhabited city.

Reserve open space for movement and combat. Keep decorative foreground objects from concealing puzzle controls, NPCs, or targets; fade obstructing architecture when necessary. Use clear shapes and interaction cues in addition to color to identify hazards and usable objects.

Apply the same smooth rendering and material language to characters and props. Character clothing, proportions, and portraits still need their own visual references.

## First playable location

For The Silent Pump, use a damp canal-side maintenance district with dark masonry, brass-edged machinery, amber lanterns, and teal water. Place the steam-routing puzzle and automaton encounter within a readable pump-house layout. Treat the toxic sewer image as a reference for a possible later polluted area, not a requirement to make the opening district toxic.
