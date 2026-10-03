from PIL import Image, ImageDraw

BASE = r"c:\Users\Admin\Desktop\iQIYI_Piper_Gosia_1.3\Nowy folder (2)\netflix-cenzor-ext\icons"
import os
os.makedirs(BASE, exist_ok=True)

def draw_icon(S):
    # Tlo: gleboka czerwiec Netflixa, zaokraglony kwadrat
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(S * 0.22)
    d.rounded_rectangle([1, 1, S - 2, S - 2], radius=r, fill=(229, 9, 20, 255))
    # Subtelna wewnetrzna ramka
    d.rounded_rectangle([1, 1, S - 2, S - 2], radius=r, outline=(0, 0, 0, 90), width=max(1, S // 64))
    # Glosnik (bialy): prostokat + trojkat tuby
    spk = [
        (0.24 * S, 0.44 * S), (0.40 * S, 0.44 * S),
        (0.54 * S, 0.30 * S), (0.54 * S, 0.70 * S),
        (0.40 * S, 0.56 * S), (0.24 * S, 0.56 * S),
    ]
    d.polygon(spk, fill=(255, 255, 255, 255))
    # Przekreslenie / X cenzury (bialy, gruby, z ciemna obwiednia)
    w = max(2, int(S * 0.10))
    x0, y0, x1, y1 = 0.60 * S, 0.36 * S, 0.82 * S, 0.64 * S
    for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
        d.line([x0 + dx, y0 + dy, x1 + dx, y1 + dy], fill=(20, 20, 24, 255), width=w + max(1, S // 64))
        d.line([x1 + dx, y0 + dy, x0 + dx, y1 + dy], fill=(20, 20, 24, 255), width=w + max(1, S // 64))
    d.line([x0, y0, x1, y1], fill=(255, 255, 255, 255), width=w)
    d.line([x1, y0, x0, y1], fill=(255, 255, 255, 255), width=w)
    return img

for S in (16, 48, 128):
    im = draw_icon(S)
    p = os.path.join(BASE, "icon-%d.png" % S)
    im.save(p, "PNG")
    print("OK", p, im.size)
