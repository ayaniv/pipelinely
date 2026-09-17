import os

number = os.environ["PR_NUMBER"]
title = os.environ["PR_TITLE"]
url = os.environ["PR_URL"]
date = os.environ["MERGED_AT"][:10]

path = "CHANGELOG.md"
with open(path) as f:
    content = f.read()

# Idempotency: don't double-append if this PR is already logged
# (e.g. a re-run of this workflow).
marker = f"[#{number}]({url})"
if marker in content:
    print(f"#{number} already present in {path}, skipping")
    raise SystemExit(0)

entry = f"- [#{number}]({url}) {title}\n"
heading = f"## {date}\n"

lines = content.splitlines(keepends=True)
first_heading_idx = next(
    (i for i, line in enumerate(lines) if line.startswith("## ")), len(lines)
)

if first_heading_idx < len(lines) and lines[first_heading_idx] == heading:
    # Same day as the latest existing entry: insert as the newest
    # bullet directly under that heading.
    insert_at = first_heading_idx + 1
    if insert_at < len(lines) and lines[insert_at].strip() == "":
        insert_at += 1
    lines.insert(insert_at, entry)
else:
    # New day: insert a fresh heading + entry above the existing entries.
    lines[first_heading_idx:first_heading_idx] = [heading, "\n", entry, "\n"]

with open(path, "w") as f:
    f.writelines(lines)
