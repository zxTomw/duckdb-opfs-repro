#!/usr/bin/env python3
"""Prepare the BEIR NFCorpus for same-origin DuckDB-Wasm JSONL import.

Usage:
  python3 scripts/prepare_nfcorpus.py --source /path/to/nfcorpus
  python3 scripts/prepare_nfcorpus.py  # download official BEIR archive
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import sys
import urllib.request
import zipfile

SOURCE_URL = "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip"
EXPECTED_DOCUMENTS = 3633
QUERY_ID = "PLAIN-3074"
EXPECTED_QUERY = "How to Help Prevent Abdominal Aortic Aneurysms"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_files(source: Path | None) -> tuple[bytes, bytes, str]:
    if source is None:
        with urllib.request.urlopen(SOURCE_URL, timeout=120) as response:
            archive_bytes = response.read()
        source_label = SOURCE_URL
        archive = zipfile.ZipFile(io.BytesIO(archive_bytes))
    elif source.is_dir():
        root = source / "nfcorpus" if (source / "nfcorpus" / "corpus.jsonl").is_file() else source
        return (root / "corpus.jsonl").read_bytes(), (root / "queries.jsonl").read_bytes(), str(root.resolve())
    else:
        archive = zipfile.ZipFile(source)
        source_label = str(source.resolve())

    with archive:
        # Read only known archive entries; never extract arbitrary paths to disk.
        entries = {}
        for name in archive.namelist():
            parts = Path(name).parts
            if len(parts) >= 2 and parts[-2:] in [("nfcorpus", "corpus.jsonl"), ("nfcorpus", "queries.jsonl")]:
                entries[parts[-1]] = name
        if set(entries) != {"corpus.jsonl", "queries.jsonl"}:
            raise ValueError("NFCorpus archive is missing corpus.jsonl or queries.jsonl")
        return archive.read(entries["corpus.jsonl"]), archive.read(entries["queries.jsonl"]), source_label


def records(data: bytes, label: str):
    for line_number, line in enumerate(data.decode("utf-8-sig").splitlines(), 1):
        if not line.strip():
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{label}:{line_number}: {exc}") from exc


def prepare(corpus_bytes: bytes, query_bytes: bytes) -> tuple[bytes, str]:
    seen = set()
    output = []
    for row in records(corpus_bytes, "corpus.jsonl"):
        doc_id = row.get("_id")
        title = row.get("title", "")
        body = row.get("text", "")
        if not isinstance(doc_id, str) or not doc_id or doc_id in seen:
            raise ValueError(f"missing or duplicate document ID: {doc_id!r}")
        if not isinstance(title, str) or not isinstance(body, str):
            raise ValueError(f"non-string title or text for {doc_id}")
        contents = " ".join(part for part in (title, body) if part)
        if not contents.strip():
            raise ValueError(f"empty content for {doc_id}")
        seen.add(doc_id)
        output.append(json.dumps({"id": doc_id, "contents": contents}, ensure_ascii=False, separators=(",", ":")))
    if len(output) != EXPECTED_DOCUMENTS:
        raise ValueError(f"expected {EXPECTED_DOCUMENTS} documents, found {len(output)}")

    matching_queries = [row.get("text") for row in records(query_bytes, "queries.jsonl") if row.get("_id") == QUERY_ID]
    if matching_queries != [EXPECTED_QUERY]:
        raise ValueError(f"unexpected {QUERY_ID} query: {matching_queries!r}")
    return ("\n".join(output) + "\n").encode("utf-8"), matching_queries[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="extracted NFCorpus directory or official zip file")
    parser.add_argument("--output", type=Path, default=Path("public/nfcorpus.jsonl"))
    args = parser.parse_args()

    corpus_bytes, query_bytes, source_label = source_files(args.source)
    output_bytes, query = prepare(corpus_bytes, query_bytes)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(output_bytes)
    report = {
        "source_url": SOURCE_URL,
        "source_used": source_label,
        "documents": EXPECTED_DOCUMENTS,
        "query_id": QUERY_ID,
        "query": query,
        "sha256": {
            "corpus_jsonl": sha256(corpus_bytes),
            "queries_jsonl": sha256(query_bytes),
            "output_jsonl": sha256(output_bytes),
        },
        "output": str(args.output),
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        print(f"NFCorpus preparation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
