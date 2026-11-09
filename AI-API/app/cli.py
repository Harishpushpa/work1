import argparse
import json
import os
import sys

from app.pipeline.pipeline import process_document


def save(name, data):
    with open(name, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="PDF or DOCX file")
    ap.add_argument(
        "--verbose", action="store_true", help="detected headings ellaam print pannum"
    )
    args = ap.parse_args()

    if not os.path.isfile(args.path):
        sys.exit(f"File kedaikala: {args.path}")

    try:
        result = process_document(args.path, verbose=args.verbose)
    except Exception as e:
        sys.exit(f"Failed: {type(e).__name__}: {e}")

    st = result["stats"]
    print(
        f"\nGenerated {st['generated']}, dropped {st['dropped']}, after dedupe {st['final']}"
    )
    if not st["final"]:
        print("WARNING: FAQ onnum varala - parse / model output check pannunga.")

    save("faqs_general.json", result["general_faqs"])
    save("faqs_specific.json", result["specific_faqs"])
    save("section_summaries.json", result["section_summaries"])
    print(f"General FAQs : {len(result['general_faqs'])}  -> faqs_general.json")
    print(f"Specific FAQs: {len(result['specific_faqs'])}  -> faqs_specific.json")
    print(f"Summaries    : {len(result['section_summaries'])}  -> section_summaries.json")

    if st["needs_review"]:
        print(f"Needs review : {st['needs_review']} (same question, different answer)")
    if result["skipped_sections"]:
        save("skipped_sections.json", result["skipped_sections"])
        print(
            f"SKIPPED sections: {len(result['skipped_sections'])} -> skipped_sections.json"
        )


if __name__ == "__main__":
    main()
