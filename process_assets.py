import os
from PIL import Image

def make_transparent(img_path):
    if not os.path.exists(img_path):
        return
    img = Image.open(img_path)
    img = img.convert("RGBA")
    datas = img.getdata()

    new_data = []
    # AI generated "white backgrounds" are usually 255,255,255 or very close.
    # We remove anything where all RGB components are > 230.
    for item in datas:
        # If it's a "bright" pixel (near white)
        if item[0] > 230 and item[1] > 230 and item[2] > 230:
            # Make it fully transparent
            new_data.append((255, 255, 255, 0))
        else:
            new_data.append(item)

    img.putdata(new_data)
    img.save(img_path, "PNG")

assets_dir = "/Users/paultanchi/Rip off Brawl stars/assets"
files = ["player.png", "enemy.png", "bullet.png", "wall.png"]

for f in files:
    print(f"Processing {f}...")
    make_transparent(os.path.join(assets_dir, f))
