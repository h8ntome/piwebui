/**
 * TEST-ONLY extension for isolated Pi homes. When a prompt contains ASKCONFIRM,
 * it raises a blocking ctx.ui.confirm — used to prove:
 *   - terminal mode: bridge OBSERVES ui_prompt_start but cannot answer (P0 gate evidence)
 *   - managed mode: the host's ExtensionUIContext routes the dialog to the browser
 *     and exactly one answer resolves it.
 * Nothing in production loads this file.
 */
export default function dialogTrigger(pi) {
  pi.on("input", async (event, ctx) => {
    if (typeof event.text === "string" && event.text.includes("ASKCONFIRM")) {
      const ok = await ctx.ui.confirm("Test gate", "Approve the test thing?");
      return { action: "transform", text: `${event.text} | confirm=${ok ? "yes" : "no"}` };
    }
    return { action: "continue" };
  });
  pi.registerCommand("asktest", {
    description: "TEST: open a select dialog from a command context",
    handler: async (_args, ctx) => {
      const pick = await ctx.ui.select("Pick one", ["alpha", "beta"]);
      ctx.ui.notify(`picked ${pick ?? "nothing"}`, "info");
    },
  });
}
