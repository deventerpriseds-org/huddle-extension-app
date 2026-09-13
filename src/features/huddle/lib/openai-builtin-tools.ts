// WHAT:       The OpenAI Responses BUILT-IN tool definitions Huddle offers its agents
//             (`code_interpreter`, `image_generation`) plus the filename -> MIME mapping used to land
//             whatever they produce in the artifact store with a real, openable file type.
// WHY:        The owner reported agents refusing to produce images or Word/PowerPoint, saying they are
//             limited to `.md`. That refusal was CORRECT about the toolset it was given: `mergedTools`
//             (huddle.functions.ts) contained only custom `type:"function"` tools and
//             `snapshotResponsesTools` (openai-assistants.server.ts) explicitly drops code_interpreter,
//             so the model was handed a strictly smaller toolset than ChatGPT's and had no way to emit
//             a binary file. These two definitions are that missing half.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/LANE-A-builtin-tools.md
//
// WHY A SEPARATE MODULE, AND WHY IT IS DEPENDENCY-FREE. Exactly the reason artifact-tool.ts gives for
// itself: the turn engine imports these STATICALLY, so anything server-only in here would drag pg/blob
// into the client bundle. These are plain constants; the execution side lives in
// openai-responses.server.ts (fetching container files) and huddle.functions.ts (landing artifacts).
//
// THESE ARE NOT `type:"function"` TOOLS AND DO NOT ROUTE THROUGH `onToolCall`. OpenAI executes a
// built-in tool server-side, INSIDE the same Responses call, and reports what it did as extra OUTPUT
// ITEMS on the response (`code_interpreter_call`, `image_generation_call`) plus, for files it wrote, a
// `container_file_citation` annotation on the message text. There is no `function_call` item and no
// output for us to submit -- see extractBuiltInFiles in openai-responses.server.ts.
//
// Every field name below was read out of the OpenAI SDK's own generated type declarations
// (openai@7.15.0, `resources/responses/responses.d.ts`) rather than written from memory:
//   * `Tool.CodeInterpreter`  responses.d.ts:8304  -- `container` is REQUIRED, not optional.
//   * `Tool.ImageGeneration`  responses.d.ts:8353  -- every field except `type` is optional.

/**
 * Run Python server-side and hand back whatever it writes. This is what makes a real .docx / .pptx /
 * .xlsx / .csv possible -- the model writes the file with python-docx/pptx/openpyxl in the container
 * and we pull the bytes out of the container afterwards.
 *
 * `container: { type: "auto" }` lets OpenAI provision (and bill) a container per turn rather than us
 * managing container lifetimes. `container` has no default -- omitting it is a 400.
 */
export const CODE_INTERPRETER_TOOL = {
  type: "code_interpreter",
  container: { type: "auto" },
} as const;

/**
 * Generate an image. The bytes come back base64 in the `result` field of the `image_generation_call`
 * output item, so nothing else has to be fetched.
 *
 * `output_format: "png"` is pinned deliberately: the artifact store records ONE mime per row and the
 * OneDrive mirror re-uses it, so a format that varies per call would make the stored mime a guess.
 * PNG is also the only format that survives a transparent background.
 */
export const IMAGE_GENERATION_TOOL = {
  type: "image_generation",
  output_format: "png",
} as const;

/** Both built-ins, in the order they are offered. */
export const BUILTIN_RESPONSES_TOOLS: readonly unknown[] = [
  CODE_INTERPRETER_TOOL,
  IMAGE_GENERATION_TOOL,
];

/**
 * The `type` values of the built-ins THIS module offers. Used in two places that must not drift:
 * the "dropped unsupported assistant tools" warning in huddle.functions.ts (a snapshot's
 * code_interpreter is no longer an unwired capability, so warning about it is now noise), and the
 * built-ins-only retry in openai-responses.server.ts.
 */
export const BUILTIN_TOOL_TYPES: readonly string[] = BUILTIN_RESPONSES_TOOLS.map(
  (t) => (t as { type: string }).type,
);

/**
 * The system hint that tells the model these exist and WHAT TO DO WITH THE RESULT. Additive: appended
 * alongside the other *_SYSTEM_HINT blocks, it takes nothing away from any agent's prompt.
 *
 * The second paragraph is the load-bearing one. A file written inside the code-interpreter container is
 * captured and saved automatically by the runtime, so an agent that ALSO calls create_artifact with a
 * markdown re-write of the same thing produces two documents for one deliverable.
 */
export const BUILTIN_TOOLS_SYSTEM_HINT =
  "REAL FILES — you are NOT limited to markdown. You have a Python code interpreter and an image " +
  "generator. Use them whenever the user asks for a format only a real file can carry: a Word " +
  "document (python-docx), a PowerPoint deck (python-pptx), an Excel workbook or CSV (openpyxl/pandas), " +
  "a chart or diagram (matplotlib), or a picture/logo/mockup (the image generator). Write the file to " +
  "disk in the container with a short, descriptive filename and the correct extension — that filename " +
  "becomes the document's name. Never tell the user you can only produce markdown, and never hand them " +
  "code and ask them to run it themselves when you can just produce the file.\n" +
  "Anything you write to a file, and any image you generate, is saved to the user's documents " +
  "AUTOMATICALLY and appears as a chip they can open — you do NOT need to call create_artifact for it, " +
  "and doing so would file the same deliverable twice. create_artifact remains the right tool for a " +
  "written brief/analysis you compose directly in your reply rather than build in code.";

// MIME by extension. Every value here was read from `mime-db@1.54.0`'s db.json in this session (the
// canonical IANA-backed table the Node ecosystem uses) rather than typed from memory -- a wrong mime
// is not cosmetic here, it is what decides whether the browser and OneDrive open the file natively or
// download it as an unknown blob.
const MIME_BY_EXT: Record<string, string> = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
};

/**
 * MIME for a produced filename. Unknown extensions fall back to `application/octet-stream` — an honest
 * "some binary file" that still downloads correctly, never a guessed text type that would make the
 * preview pane try to render bytes as UTF-8.
 */
export function mimeForFilename(filename: string): string {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(filename)?.[1] ?? "").toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * The last path segment of a container path, with any directory prefix stripped. Container files are
 * reported with a full in-container path (`/mnt/data/report.docx`); the artifact's NAME should be the
 * file, not the path.
 */
export function basenameOf(pathOrName: string): string {
  const parts = pathOrName.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? pathOrName;
}
