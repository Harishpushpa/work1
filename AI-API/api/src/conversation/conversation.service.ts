import { ConversationRepository } from "./conversation.repository";
import { SaveConversationMessageRequest } from "./conversation.types";

export class ConversationService {

    private readonly repository = new ConversationRepository();

    async getMessages(
        conversationId: string
    ): Promise<any[]> {

        return this.repository.getMessages(conversationId);

    }

    async saveMessage(
        request: SaveConversationMessageRequest
    ): Promise<void> {

        await this.repository.saveMessage(request);

    }

    async deleteMessages(
        conversationId: string
    ): Promise<void> {

        await this.repository.deleteMessages(conversationId);

    }

}
