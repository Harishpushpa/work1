import { qdrantClient } from "./qdrant.client";

export class QdrantCollectionService {

  async exists(collection: string) {

    const collections =
      await qdrantClient.getCollections();

    return collections.collections.some(
      (c: { name: string }) => c.name === collection
    );

  }

  async create(
    collection: string,
    vectorSize: number
  ) {

    const exists = await this.exists(collection);

    if (exists) return;

    await qdrantClient.createCollection(collection, {

      vectors: {
        size: vectorSize,
        distance: "Cosine",
      },
      hnsw_config: {
        m: 16,
        ef_construct: 100,
        full_scan_threshold: 1000,
      }

    });

  }

}