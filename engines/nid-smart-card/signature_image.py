"""Isolate visible ink in an uploaded or extracted holder signature."""

from PIL import Image, ImageChops, ImageFilter


def signature_ink(image):
    """Return the original ink with a transparent background, or None."""
    rgba = image.convert("RGBA")
    opacity = rgba.getchannel("A")
    # PDF soft masks can store black underneath fully transparent pixels.
    # Estimate contrast on the image as it appears on paper.
    if opacity.getextrema()[0] < 255:
        paper = Image.new("RGBA", rgba.size, "white")
        gray = Image.alpha_composite(paper, rgba).convert("L")
    else:
        gray = rgba.convert("L")
    radius = max(8, min(gray.size) // 10)
    background = gray.filter(ImageFilter.GaussianBlur(radius))
    contrast = ImageChops.subtract(background, gray)
    alpha = ImageChops.darker(
        contrast.point(lambda d: max(0, min(255, (d - 20) * 255 // 40))),
        opacity,
    )
    if not alpha.getbbox():
        # Look for a coherent faint stroke before lowering the contrast
        # threshold. A few specks in a scan are not a signature.
        evidence = contrast.point(lambda d: 255 if d >= 7 else 0)
        evidence = evidence.filter(ImageFilter.MedianFilter(3))
        if evidence.histogram()[255] < max(8, gray.width * gray.height // 4000):
            return None
        support = evidence.filter(ImageFilter.MaxFilter(5))
        faint = contrast.point(lambda d: max(0, min(255, (d - 5) * 255 // 12)))
        alpha = ImageChops.darker(ImageChops.multiply(faint, support), opacity)

    bbox = alpha.getbbox()
    if not bbox:
        return None
    rgba.putalpha(alpha)
    margin = 2
    return rgba.crop((
        max(0, bbox[0] - margin), max(0, bbox[1] - margin),
        min(rgba.width, bbox[2] + margin), min(rgba.height, bbox[3] + margin),
    ))
