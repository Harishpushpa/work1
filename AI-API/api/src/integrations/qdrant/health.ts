import { qdrantClient } from "./qdrant.client";

export async function checkQdrantHealth() {
    try {
        await qdrantClient.getCollections();
        return {
            status: "UP",
        };
    } catch {
        return {
            status: "DOWN",
        };
    }
}