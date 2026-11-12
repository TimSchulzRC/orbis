import { describe, expect, test } from "bun:test";
import { fmtDate, fmtNumber } from "@obtion/core/i18n";
import { dateText, numberText, parseDate, parseNumber } from "@obtion/core/input";

describe("numbers as typed", () => {
	test("grouping and decimal mark of the app language", () => {
		expect(parseNumber("de", "1.234,5")).toBe(1234.5);
		expect(parseNumber("en", "1,234.5")).toBe(1234.5);
		expect(parseNumber("en", "1,235")).toBe(1235);
		expect(parseNumber("de", "1.235")).toBe(1235);
		expect(parseNumber("de", "1 234 567,25")).toBe(1234567.25);
		expect(parseNumber("en", "-0.5")).toBe(-0.5);
	});

	test("a lone separator that is no grouping is the decimal mark", () => {
		expect(parseNumber("de", "1.5")).toBe(1.5);
		expect(parseNumber("en", "1,5")).toBe(1.5);
		expect(parseNumber("de", "12,50")).toBe(12.5);
	});

	test("what is no number stays none", () => {
		for (const s of ["", "  ", "abc", "1,2,3", "1.2.3", "1,234.5,6", "12a"])
			expect(parseNumber("en", s)).toBeUndefined();
		expect(parseNumber("de", "1,2,3")).toBeUndefined();
	});

	test("the field's text reads back as the same number, also what the display shows", () => {
		for (const lang of ["de", "en"] as const)
			for (const n of [0, 1235, 1234.5, -0.25, 1234567.125, 0.1 + 0.2]) {
				expect(parseNumber(lang, numberText(lang, n))).toBe(n);
				if (Number.isInteger(n * 1000)) expect(parseNumber(lang, fmtNumber(lang, n))).toBe(n);
			}
		expect(numberText("de", 1234.5)).toBe("1234,5");
		expect(numberText("en", 1234.5)).toBe("1234.5");
	});
});

describe("dates in English", () => {
	test("shown, typed and read in one order (US)", () => {
		expect(fmtDate("en", "2026-10-03")).toBe("10/03/2026");
		expect(dateText("en", "2026-10-03")).toBe("10/03/2026");
		expect(parseDate(dateText("en", "2026-10-03"), "2026-01-01")).toBe("2026-10-03");
		expect(parseDate(fmtDate("en", "2026-10-03"), "2026-01-01")).toBe("2026-10-03");
	});

	test("German stays day first", () => {
		expect(fmtDate("de", "2026-10-03")).toBe("03.10.2026");
		expect(dateText("de", "2026-10-03")).toBe("03.10.2026");
		expect(parseDate(dateText("de", "2026-10-03"), "2026-01-01")).toBe("2026-10-03");
	});
});
