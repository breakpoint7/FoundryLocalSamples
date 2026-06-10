import re
import json
import pathlib

# Convert markdown to embedding docs.
# Content cloned from https://github.com/MicrosoftDocs/azure-docs and processed into chunks for RAG demos.
# Assumes files.txt was prepared with a command like:
#   Get-ChildItem -Recurse articles/api-management -Filter *.md |
#       Select-Object -First 100 |
#       ForEach-Object { $_.FullName } > files.txt
# (PowerShell `>` writes UTF-16, hence the encoding below.)

REPO_ROOT = pathlib.Path("C:/testpad/azuredocs/azure-docs")
FILES_LIST = REPO_ROOT / "files.txt"
OUTPUT = pathlib.Path("docs.json")

CHUNK_SIZE = 1500     # chars per chunk (~350-450 tokens)
CHUNK_OVERLAP = 200   # chars of overlap between chunks


def parse_frontmatter(text):
    """Extract YAML frontmatter title + return body without frontmatter."""
    m = re.match(r'^---\s*\n(.*?)\n---\s*\n', text, flags=re.DOTALL)
    if not m:
        return "", text
    fm = m.group(1)
    title_match = re.search(r'^title:\s*"?(.+?)"?\s*$', fm, flags=re.M)
    title = title_match.group(1).strip() if title_match else ""
    return title, text[m.end():]


def clean_markdown(text):
    """Strip noise that hurts embedding quality."""
    text = re.sub(r'<!--.*?-->', '', text, flags=re.DOTALL)        # HTML comments
    text = re.sub(r':::.*?:::', '', text, flags=re.DOTALL)          # Learn :::zone/:::image blocks
    text = re.sub(r'```.*?```', '', text, flags=re.DOTALL)          # fenced code (optional)
    text = re.sub(r'\[!INCLUDE\s*\[.*?\]\(.*?\)\s*\]', '', text)    # INCLUDE directives
    text = re.sub(r'\[!NOTE\]|\[!TIP\]|\[!IMPORTANT\]|\[!WARNING\]|\[!CAUTION\]', '', text)
    text = re.sub(r'!?\[([^\]]*)\]\([^)]*\)', r'\1', text)          # links + images -> keep label
    text = re.sub(r'^#+\s*', '', text, flags=re.M)                  # heading markers (keep text)
    text = re.sub(r'\n{3,}', '\n\n', text)                          # collapse blank lines
    return text.strip()


def chunk_text(text, size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Split into overlapping char windows."""
    if not text:
        return
    step = size - overlap
    for start in range(0, len(text), step):
        chunk = text[start:start + size].strip()
        if chunk:
            yield chunk
        if start + size >= len(text):
            break


def derive_learn_url(path):
    """Map a local azure-docs path to its public Learn URL (best effort)."""
    try:
        rel = pathlib.Path(path).resolve().relative_to(REPO_ROOT.resolve())
    except ValueError:
        return ""
    parts = rel.as_posix().removesuffix(".md")
    if parts.startswith("articles/"):
        parts = parts[len("articles/"):]
    return f"https://learn.microsoft.com/azure/{parts}"


with open(FILES_LIST, encoding="utf-16") as f:
    files = [line.strip() for line in f if line.strip()]

docs = []
for i, path in enumerate(files):
    with open(path, encoding="utf-8") as f:
        raw = f.read()

    title, body = parse_frontmatter(raw)
    cleaned = clean_markdown(body)

    for j, chunk in enumerate(chunk_text(cleaned)):
        docs.append({
            "id": f"doc-{i}-chunk-{j}",
            "source": path,
            "title": title,
            "url": derive_learn_url(path),
            "content": chunk,
        })

with open(OUTPUT, "w", encoding="utf-8") as f:
    json.dump(docs, f, indent=2, ensure_ascii=False)

print(f"Wrote {len(docs)} chunks from {len(files)} files to {OUTPUT}")