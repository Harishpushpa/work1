import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.haystack.pipelines.retrieval_pipeline import get_retrieval_pipeline


def main():
    pipeline = get_retrieval_pipeline()

    result = pipeline.run(
        {
            "embedder": {
                "text": "What is geography?"
            }
        }
    )

    print("\n=== RESULT KEYS ===")
    print(result.keys())

    documents = result["retriever"]["documents"]

    print("\nRetrieved documents:", len(documents))

    for i, document in enumerate(documents, 1):
        print(f"\n--- Document {i} ---")
        print("Score:", document.score)
        print("Content:", document.content[:300] if document.content else "")
        print("Meta text:", (document.meta or {}).get("text", "")[:300])


if __name__ == "__main__":
    main()