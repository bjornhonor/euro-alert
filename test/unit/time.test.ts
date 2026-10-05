import { describe, expect, it } from "vitest";
import { brt, floorTo15Min, isAlertWindow, isWeekday } from "../../src/lib/time";

const utc = (iso: string) => Date.parse(iso);

describe("horário de Brasília", () => {
  it("converte UTC para UTC−3", () => {
    expect(brt(utc("2026-09-25T11:00:00Z"))).toMatchObject({ date: "2026-09-25", hour: 8, weekday: 5 });
  });

  it("vira o dia na meia-noite de Brasília, não na de UTC", () => {
    expect(brt(utc("2026-09-26T02:59:00Z")).date).toBe("2026-09-25");
    expect(brt(utc("2026-09-26T03:00:00Z")).date).toBe("2026-09-26");
  });

  it("dia útil segue o calendário de Brasília", () => {
    expect(isWeekday(utc("2026-09-26T02:00:00Z"))).toBe(true); // sexta 23h em Brasília
    expect(isWeekday(utc("2026-09-26T04:00:00Z"))).toBe(false); // sábado 1h
    expect(isWeekday(utc("2026-09-28T03:00:00Z"))).toBe(true); // segunda 0h
  });
});

describe("janela de alertas (8h–22h, dias úteis)", () => {
  const inWindow = (iso: string) => isAlertWindow(utc(iso), 8, 22);

  it("abre às 8h e fecha às 22h", () => {
    expect(inWindow("2026-09-25T10:59:00Z")).toBe(false); // 7h59
    expect(inWindow("2026-09-25T11:00:00Z")).toBe(true); // 8h
    expect(inWindow("2026-09-26T00:59:00Z")).toBe(true); // 21h59
    expect(inWindow("2026-09-26T01:00:00Z")).toBe(false); // 22h
  });

  it("fica fechada no fim de semana", () => {
    expect(inWindow("2026-09-26T15:00:00Z")).toBe(false); // sábado 12h
  });
});

describe("floorTo15Min", () => {
  it("arredonda para baixo no quarto de hora", () => {
    expect(floorTo15Min(utc("2026-09-25T11:14:59Z"))).toBe(utc("2026-09-25T11:00:00Z"));
    expect(floorTo15Min(utc("2026-09-25T11:15:00Z"))).toBe(utc("2026-09-25T11:15:00Z"));
  });
});
