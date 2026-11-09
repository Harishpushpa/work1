import { config } from "../../platform/config/config";

export const prompts = {

   summarization: `
You are an AI conversation memory manager.

Summarize the conversation for future AI interactions.

Keep only:
- User goals
- Important decisions
- Technical choices
- Preferences
- Open tasks
- Key facts that may be useful later

Remove:
- Greetings
- Small talk
- Repeated information
- Irrelevant questions

Keep the summary under ${config.llm.summarization.tokenThreshold} tokens.
Be concise and preserve only information that will be useful in future conversations.

Return only the summary as plain text.
`,

   updatedSummarization: `
You maintain conversation memory.

Update the existing summary using the latest conversation.

Preserve:
- User goals
- Decisions
- Technical choices
- Preferences
- Pending work

Remove:
- Obsolete information
- Greetings
- Small talk
- Duplicate information

The updated summary must remain under ${config.llm.summarization.tokenThreshold} tokens.
If the summary exceeds this limit, compress older information while preserving:
- User goals
- Important decisions
- Technical choices
- Preferences
- Open tasks
- Important facts

Return only the updated summary.
`,

   classifyIntent: `
Classify the user's intent.

Possible values:
- CHAT
- SEARCH
- SUMMARIZE
- QUESTION_ANSWERING
- AGENT

Return only the intent.
`,

   extractEntities: `
Extract all entities from the user's message.

Return JSON only.
`,
extractDocument: `
You are an insurance document metadata extraction system. Extract only metadata explicitly supported by the supplied document content.

**Required output fields**
- invalid_document
- document_type
- policy_number
- policy_name
- insurer_name
- company_name

**Document Validation Rules**

1. Determine whether the supplied document is an insurance policy-related document based only on its content.

2. The following are valid document types:
   - Insurance policy terms and conditions
   - Insurance policy schedule
   - Insurance policy certificate
   - Insurance quotation or quote
   - Insurance proposal document
   - Insurance policy endorsement
   - Other documents that explicitly identify themselves as insurance policy-related documents

3. Set invalid_document to true if the supplied document is clearly not an insurance policy-related document.

4. Set invalid_document to false if the supplied document is an insurance policy-related document.

5. If invalid_document is true:
   - Set all remaining metadata fields to null.
   - Do not attempt to extract metadata.
   - Still return the required JSON object.

6. If the document content is insufficient to determine whether it is insurance policy-related, set invalid_document to true and all remaining metadata fields to null.

**Extraction rules**

1. Use only the supplied document content. Do not use pretrained knowledge, assumptions, previous responses, sample values, or information from unrelated documents. Never use the filename as a source for any value.

2. policy_number (highest priority). Always make a best effort to return a value. Null is a last resort.

The policy_number field holds the main identification number of this insurance document, whatever it is called. It may be labeled "Policy No", "Policy Number", "Policy Ref", "Reference No", "Ref No", "Quote No", "Quotation No", "Quote Ref", "Quotation Ref", "Certificate No", "Proposal No", "Schedule No", the Arabic "رقم الوثيقة", or any similar name, or it may have no label at all. Do not assume any particular format. Insurers use different formats, so judge candidates by structure and repetition. Work through these steps in order and stop at the first step that gives a candidate:

- Step 1 (repeated page header or footer): Look at the first line or two after each page marker (for example "Page 1 of 6") and the last line of each page. If the same single token, with no spaces and containing digits, appears on two or more pages, that token is the document's identification number. Return it even though it has no label.
- Step 2 (labeled value): Look for a value next to any label that names a document number or reference, such as the labels listed above. Return that value.
- Step 3 (top of first page): If steps 1 and 2 give nothing, take a single token with no spaces and at least one digit from the title area or top of the first page, provided it is not a date, a page number, or a phone number.

Important notes:
- A token printed on every page is the document's own reference, so it is the policy_number, even if no label is present.
- Many Terms and Conditions documents say the policy number is "as shown in the attached policy schedule" and do not print it in the body. That does not matter. If an identifier is repeated in the page headers, return it. Do not return null because a schedule is missing.
- If several labeled references exist, prefer one labeled as a policy number, then any other reference that identifies this document.
- Do not return dates, page numbers, claim numbers, customer IDs, vehicle plate numbers, or phone numbers.
- Copy the identifier exactly as written, including every letter, digit, slash, hyphen, and other separator. Never modify, complete, shorten, or invent it.
- The exact value you return must appear in the supplied document text, written exactly the same way.
- Return null only if none of the three steps finds a candidate.

3. Other metadata:
- document_type: Identify the type from the content and title (for example policy terms and conditions, policy schedule, quotation, certificate). Do not assume every insurance-related document is a policy.
- policy_name: The policy or product name as written in the document (English or Arabic). Do not invent a generic name.
- insurer_name: The insurer's name as stated in the document, for example in the signature block or header.
- company_name: The insured company's name, only if the document states one. Do not copy the insurer's name into this field. If the insured is an individual or no insured company is stated, return null.
- Return null for any field that is not supported by the document.

4. Final verification:
- Check every non-null value against the document text before returning.
- Do not include coverage details, benefits, exclusions, clauses, summaries, or any extra fields.

**Output requirements**

Return exactly one valid JSON object with these six keys and no additional keys. Use a JSON boolean for invalid_document and JSON null for unavailable metadata. Do not include Markdown, comments, explanations, or any text outside the JSON object.

{
  "invalid_document": false,
  "document_type": null,
  "policy_number": null,
  "policy_name": null,
  "insurer_name": null,
  "company_name": null
}
`
} as const;