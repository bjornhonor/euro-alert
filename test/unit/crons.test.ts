import { describe, expect, it } from "vitest";
import wranglerConfig from "../../wrangler.jsonc?raw";
import { CRONS, jobForCron } from "../../src/jobs/crons";

/** JSONC simples: remove comentários de linha e vírgulas finais. */
function parseJsonc(text: string): { triggers: { crons: string[] } } {
  const noComments = text.replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, "$1"));
}

describe("crons", () => {
  it("wrangler.jsonc tem exatamente os crons de src/jobs/crons.ts", () => {
    const { triggers } = parseJsonc(wranglerConfig);
    expect([...triggers.crons].sort()).toEqual(Object.values(CRONS).sort());
  });

  it("usa nomes para o dia da semana, nunca números", () => {
    for (const cron of Object.values(CRONS)) {
      const dow = cron.split(" ")[4]!;
      expect(dow).toMatch(/^(\*|[A-Z]{3}(-[A-Z]{3})?)$/);
    }
  });

  it("encontra o job de cada cron", () => {
    expect(jobForCron("*/15 * * * MON-FRI")).toBe("tick");
    expect(jobForCron("0 6 * * *")).toBe("maintenance");
    expect(jobForCron("1 2 3 4 5")).toBeUndefined();
  });
});
