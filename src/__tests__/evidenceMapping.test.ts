import {
  getEvidenceMapping,
  getEvidenceMappingVersion,
} from "../services/evidenceMapping.service";

/**
 * F29 evidence-mapping reader — pure tests against the shipped
 * evidence_mapping.json. Pins the human-confirm flags that the honesty
 * gate depends on.
 */
describe("F29 getEvidenceMapping", () => {
  it("loads a mapping version (meta.date)", () => {
    expect(getEvidenceMappingVersion()).toBeTruthy();
  });

  it("turn_score requires human confirmation (self-scored → moderate)", () => {
    const m = getEvidenceMapping("beat_2_roleplay", "turn_score");
    expect(m).not.toBeNull();
    expect(m!.human_confirm).toBe(true);
    expect(m!.rarpa_stage).toContain("Stage 4");
  });

  it("vocabulary_items_used is formative (no human confirm)", () => {
    const m = getEvidenceMapping("beat_2_roleplay", "vocabulary_items_used");
    expect(m!.human_confirm).toBe(false);
  });

  it("summative_review carries the ILR achievement fields + human confirm", () => {
    const m = getEvidenceMapping("review_point", "summative_review");
    expect(m!.human_confirm).toBe(true);
    expect(m!.ilr_fields).toEqual(
      expect.arrayContaining(["CompStatus", "Outcome", "AchDate"]),
    );
  });

  it("session_complete is formative beat_3 evidence", () => {
    const m = getEvidenceMapping("beat_3_complete", "session_complete");
    expect(m).not.toBeNull();
    expect(m!.human_confirm).toBe(false);
  });

  it("returns null for an unmapped (beat, data_point)", () => {
    expect(
      getEvidenceMapping("beat_2_roleplay", "not_a_real_point"),
    ).toBeNull();
  });
});
