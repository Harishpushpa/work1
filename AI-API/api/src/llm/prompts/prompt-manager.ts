import { prompts } from "./prompts";

export class PromptManager {

    static getPrompt(
        name: keyof typeof prompts
    ): string {

        return prompts[name];

    }

}