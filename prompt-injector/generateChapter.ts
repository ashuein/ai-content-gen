// Orchestrator: attach PDF (file_id) and enforce schema/grammar for DocJSON output
import OpenAI from "openai";
import { PromptEnvelope } from "../src/buildEnvelope";
// import yourDocjsonSchema from "../schemas/json/docjson.v1.json"; // if using json_schema mode

export async function generateChapter(
  client: OpenAI,
  envelope: PromptEnvelope,
  fileId: string
) {
  const sys = envelope.messages.find(m => m.role === "system")!;
  const usr = envelope.messages.find(m => m.role === "user")!;

  const req: any = {
    model: "gpt-5",
    temperature: envelope.model_prefs?.temperature ?? 0.1,
    input: [
      { role: "system", content: [{ type: "input_text", text: sys.content }] },
      { role: "user",   content: [
          { type: "input_file", file_id: fileId },      // <— attach chapter PDF
          { type: "input_text", text: usr.content }
      ] }
    ]
  };

  // Prefer grammar/structured outputs; else json_schema with your schema object
  if (envelope.output_contract.mode === "grammar" && envelope.output_contract.grammar_ref) {
    req.response_format = { type: "grammar", grammar: envelope.output_contract.grammar_ref };
  } else {
    req.response_format = {
      type: "json_schema",
      json_schema: {
        name: "docjson.v1",
        schema: /* yourDocjsonSchema */ {},   // <- plug your full DocJSON schema object here
        strict: true
      }
    };
  }

  const resp = await client.responses.create(req);
  const docjson = JSON.parse(resp.output_text); // schema/grammar guarantees valid JSON
  return docjson; // hand off to Validator/Compilers
}
