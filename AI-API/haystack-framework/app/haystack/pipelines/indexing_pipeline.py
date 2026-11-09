# from functools import lru_cache

# from haystack import Pipeline
# from haystack.components.builders import DocumentCleaner
# from haystack.components.preprocessors import DocumentSplitter
# from haystack.dataclasses import Document

# from app.config.settings import get_settings
# from app.haystack.factories.document_store import get_document_store
# from app.haystack.factories.embedders import get_document_embedder


# @lru_cache(maxsize=32)
# def get_indexing_pipeline(
#     embedding_provider: str | None = None,
#     embedding_model: str | None = None,
# ) -> Pipeline:
#     settings = get_settings()

#     document_store = get_document_store()

#     embedder = get_document_embedder(
#         provider=embedding_provider,
#         model=embedding_model,
#     )

#     cleaner = DocumentCleaner(
#         remove_empty_lines=True,
#         remove_extra_whitespaces=True,
#         remove_repeated_substrings=False,
#     )

#     splitter = DocumentSplitter(
#         split_by="word",
#         split_length=settings.chunk_size,
#         split_overlap=settings.chunk_overlap,
#     )

#     pipeline = Pipeline()

#     pipeline.add_component(
#         "cleaner",
#         cleaner,
#     )

#     pipeline.add_component(
#         "splitter",
#         splitter,
#     )

#     pipeline.add_component(
#         "embedder",
#         embedder,
#     )

#     pipeline.add_component(
#         "writer",
#         document_store,
#     )

#     pipeline.connect(
#         "cleaner.documents",
#         "splitter.documents",
#     )

#     pipeline.connect(
#         "splitter.documents",
#         "embedder.documents",
#     )

#     pipeline.connect(
#         "embedder.documents",
#         "writer.documents",
#     )

#     return pipeline