#!/usr/bin/env python3
"""Bundle index.html, its CSS and its scripts into one self-contained page.

The output is page content without <!doctype>/<html>/<head>/<body> wrappers,
which is the shape claude.ai Artifacts expect (they add the skeleton).
Pass --full to keep the document wrapper instead, for a single-file download.

    python3 tools/build_artifact.py dist/allele-atelier.html [--full]
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def inline(html: str) -> str:
    def css(m):
        return "<style>\n" + (ROOT / m.group(1)).read_text() + "</style>"

    def js(m):
        src = (ROOT / m.group(1)).read_text()
        return "<script>\n" + src.replace("</script", "<\\/script") + "</script>"

    html = re.sub(r'<link rel="stylesheet" href="((?:css|js)/[^"]+)">', css, html)
    html = re.sub(r'<script src="(js/[^"]+)"></script>', js, html)
    return html


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    full = "--full" in sys.argv
    out = pathlib.Path(args[0] if args else ROOT / "dist" / "allele-atelier.html")
    html = inline((ROOT / "index.html").read_text())
    if not full:
        head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
        body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
        head = re.sub(r'<meta (charset|name="viewport")[^>]*>\s*', "", head)
        html = head.strip() + "\n" + body.strip() + "\n"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)
    print(f"wrote {out} ({len(html) // 1024} KB)")


if __name__ == "__main__":
    main()
