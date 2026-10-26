# Focus Stacker

Combine photos taken at different focus depths into one sharp image, right in your browser.
Made for stacks shot through a microscope, but it works for any focus stack.

**Use it:** open the GitHub Pages link for this repository on a phone, tablet or computer.
Nothing to install, and your photos are never uploaded; all processing happens on your device.

## How to use

1. Take 5–20 photos of a still subject, changing only the focus between shots.
2. Open the page, tap **Choose photos** and select the whole stack.
3. Tap **Stack photos**. Keep the page open until it finishes (about half a minute for six 6 MP photos on a laptop; phones are slower).
4. Download or share the result.

You get up to three images:

- **Pyramid**: sharpest fine detail (hairs, bristles, texture).
- **Depth map**: cleaner colours and tones, with fewer halo artefacts.
- **Depth image**: a colour map showing which photo each part of the result came from.

On a computer you can also drag in folders; each folder becomes its own stack.

## If something goes wrong

- **The result looks scrambled or ghosted:** the photos may be out of order. Try *Order by → File date*.
- **The page reloads or crashes on a phone:** the photos are too big for the phone's memory. Open *Settings → Working size* and pick a smaller size. The page lowers it automatically after a crash.
- **"Couldn't read" a photo:** use JPEG or PNG. iPhones convert HEIC photos automatically when you pick them.

## How it works

Every photo is aligned to the middle one (phase correlation followed by ECC affine refinement,
so small shifts, rotations and focus "breathing" are corrected). Then the photos are fused with a
Laplacian pyramid and/or a smoothed depth map. Photos are processed one at a time, so long stacks
don't need much more memory than short ones.

Plain HTML, CSS and JavaScript with no build step and no dependencies:
`stacker.js` is the engine, `worker.js` runs it in the background, and `app.js` drives the page.
