/**
 * 20-question adaptive placement assessment for ESOL.
 * Questions are tagged by NQF level (Entry 1 → Level 2).
 *
 * Adaptive flow: if first 5 are all wrong, continue at E1 only.
 * If first 5 are all correct, jump to L1–L2 questions.
 *
 * THIS BANK MUST BE CALIBRATED BY A QUALIFIED ESOL PRACTITIONER
 * AGAINST THE PUBLISHED ESOL CORE CURRICULUM LEVEL DESCRIPTORS
 * BEFORE LAUNCH. v1 questions are starter content for development.
 */

export interface PlacementQuestion {
  id: string;
  level: "Entry 1" | "Entry 2" | "Entry 3" | "Level 1" | "Level 2";
  prompt: string;
  type: "multiple_choice" | "free_text";
  options?: string[];
  correctAnswer?: string;
  skillCode: string; // ESOL Core Curriculum code
}

export const PLACEMENT_QUESTIONS: PlacementQuestion[] = [
  // ── Entry 1 — basic phrases, personal information ──
  {
    id: "q1",
    level: "Entry 1",
    type: "multiple_choice",
    prompt: "How do you say hello in English?",
    options: ["Goodbye", "Hello", "Yes", "Thank you"],
    correctAnswer: "Hello",
    skillCode: "Sc",
  },
  {
    id: "q2",
    level: "Entry 1",
    type: "multiple_choice",
    prompt: "Which is correct? My name ___ Maria.",
    options: ["am", "is", "are", "be"],
    correctAnswer: "is",
    skillCode: "Ws",
  },
  {
    id: "q3",
    level: "Entry 1",
    type: "free_text",
    prompt: "Write one sentence to introduce yourself in English.",
    skillCode: "Wt",
  },
  {
    id: "q4",
    level: "Entry 1",
    type: "multiple_choice",
    prompt: "What does this sign mean? STOP",
    options: ["Go fast", "Wait here", "Stop", "Turn left"],
    correctAnswer: "Stop",
    skillCode: "Rt",
  },
  // ── Entry 2 — simple routine tasks ──
  {
    id: "q5",
    level: "Entry 2",
    type: "multiple_choice",
    prompt: "Which is correct? Yesterday I ___ to the shop.",
    options: ["go", "going", "went", "gone"],
    correctAnswer: "went",
    skillCode: "Ws",
  },
  {
    id: "q6",
    level: "Entry 2",
    type: "free_text",
    prompt: "Describe what you did this morning. Use 2 or 3 sentences.",
    skillCode: "Wt",
  },
  {
    id: "q7",
    level: "Entry 2",
    type: "multiple_choice",
    prompt: "You want to ask the time. What do you say?",
    options: [
      "What time?",
      "Excuse me, what time is it, please?",
      "Time?",
      "How time?",
    ],
    correctAnswer: "Excuse me, what time is it, please?",
    skillCode: "Sc",
  },
  {
    id: "q8",
    level: "Entry 2",
    type: "multiple_choice",
    prompt: "Which sentence is correct?",
    options: [
      "She don't like coffee.",
      "She doesn't like coffee.",
      "She not like coffee.",
      "She no like coffee.",
    ],
    correctAnswer: "She doesn't like coffee.",
    skillCode: "Ws",
  },
  // ── Entry 3 — describe experiences ──
  {
    id: "q9",
    level: "Entry 3",
    type: "free_text",
    prompt:
      "Describe your favourite place. Where is it? Why do you like it? Use 3 to 4 sentences.",
    skillCode: "Wt",
  },
  {
    id: "q10",
    level: "Entry 3",
    type: "multiple_choice",
    prompt: "If it rains tomorrow, I ___ stay at home.",
    options: ["will", "would", "am", "is"],
    correctAnswer: "will",
    skillCode: "Ws",
  },
  {
    id: "q11",
    level: "Entry 3",
    type: "multiple_choice",
    prompt:
      "Read: 'The library opens at 9 a.m. and closes at 8 p.m. on weekdays. On Saturdays it closes at 5 p.m.' At what time does the library close on Saturday?",
    options: ["9 a.m.", "5 p.m.", "8 p.m.", "It is closed."],
    correctAnswer: "5 p.m.",
    skillCode: "Rt",
  },
  {
    id: "q12",
    level: "Entry 3",
    type: "free_text",
    prompt:
      "You are at a doctor's appointment. Write what you would say to describe a headache and ask for advice.",
    skillCode: "Sc",
  },
  // ── Level 1 — interact with fluency ──
  {
    id: "q13",
    level: "Level 1",
    type: "multiple_choice",
    prompt: "Which is the most polite way to make a request at work?",
    options: [
      "Give me the report.",
      "I want the report.",
      "Could you send me the report when you have a moment, please?",
      "Send report now.",
    ],
    correctAnswer:
      "Could you send me the report when you have a moment, please?",
    skillCode: "Sc",
  },
  {
    id: "q14",
    level: "Level 1",
    type: "free_text",
    prompt:
      "Write a short email (4–5 sentences) to your manager explaining that you cannot come to work tomorrow because you are unwell.",
    skillCode: "Wt",
  },
  {
    id: "q15",
    level: "Level 1",
    type: "multiple_choice",
    prompt: "If I had known about the meeting, I ___ attended.",
    options: ["will", "would have", "had", "would"],
    correctAnswer: "would have",
    skillCode: "Ws",
  },
  {
    id: "q16",
    level: "Level 1",
    type: "multiple_choice",
    prompt:
      "Read: 'Despite the heavy rain, the festival went ahead as planned.' What does this sentence mean?",
    options: [
      "The festival was cancelled because of rain.",
      "The festival happened even though it rained heavily.",
      "It rained at the festival.",
      "The festival was rescheduled.",
    ],
    correctAnswer: "The festival happened even though it rained heavily.",
    skillCode: "Rt",
  },
  // ── Level 2 — complex text, GCSE level ──
  {
    id: "q17",
    level: "Level 2",
    type: "free_text",
    prompt:
      "Write a paragraph (5–6 sentences) arguing for or against this statement: 'Public transport should be free for everyone.' Give reasons.",
    skillCode: "Wt",
  },
  {
    id: "q18",
    level: "Level 2",
    type: "multiple_choice",
    prompt: "Which sentence uses the passive voice correctly?",
    options: [
      "The cake was eat by the children.",
      "The cake was eaten by the children.",
      "The cake eaten by the children.",
      "The cake is eat by the children.",
    ],
    correctAnswer: "The cake was eaten by the children.",
    skillCode: "Ws",
  },
  {
    id: "q19",
    level: "Level 2",
    type: "free_text",
    prompt:
      "Read this scenario and respond: 'Your colleague has been working long hours and seems stressed. They tell you they're thinking of leaving the company.' What would you say to them and why?",
    skillCode: "Sd",
  },
  {
    id: "q20",
    level: "Level 2",
    type: "multiple_choice",
    prompt:
      "Which word best fits? 'The committee's decision was ___; everyone agreed.'",
    options: ["controversial", "unanimous", "ambiguous", "tentative"],
    correctAnswer: "unanimous",
    skillCode: "Rw",
  },
];

export const getQuestionsForAssessment = (): PlacementQuestion[] => {
  return PLACEMENT_QUESTIONS;
};

/**
 * Adaptive next-question selector. After the first 5 questions:
 * - All correct → jump to L1/L2 only
 * - All wrong → stay at E1 only
 * - Mixed → continue mixed
 */
export const getAdaptiveQuestions = (
  firstFiveCorrect: number,
): PlacementQuestion[] => {
  if (firstFiveCorrect >= 5) {
    // Skip remaining E1/E2 — return L1/L2 only
    return PLACEMENT_QUESTIONS.filter(
      (q) => q.level === "Level 1" || q.level === "Level 2",
    );
  }
  if (firstFiveCorrect === 0) {
    // Stay at E1
    return PLACEMENT_QUESTIONS.filter((q) => q.level === "Entry 1");
  }
  // Mixed — return all 20
  return PLACEMENT_QUESTIONS;
};
