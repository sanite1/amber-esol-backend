/**
 * The five Version-1 ESOL scenarios.
 * Each is a structured teaching unit consumed by the Gemini system prompt
 * builder. Translations cover the top 5 UK resettlement L1 languages:
 *   ar = Arabic, so = Somali, fa = Dari/Pashto, ti = Tigrinya, zh = Cantonese.
 *
 * NOTE: model dialogues, expanded vocabulary, and full L1 translation passes
 * require ESOL practitioner authoring + community review before launch.
 * v1 ships with anchor vocab in 5 L1s; complete dialogues are stubs.
 */

export interface VocabularyItem {
  word: string;
  definition: string;
  translations?: { ar?: string; so?: string; fa?: string; ti?: string; zh?: string };
  exampleSentence?: string;
}

export interface ScenarioUnit {
  scenarioId: string;
  title: string;
  esolLevelRange: string[];
  skillCodes: string[];
  vocabulary: VocabularyItem[];
  grammarTargets: string[];
  modelDialogue: string;
  roleplayPrompt: string;
  comprehensionQuestions: { q: string; modelAnswer: string }[];
  passThreshold: number;
  culturalNotes: string;
  vocabularyReinforcementWeight: number;
}

export const S1_GP_APPOINTMENT: ScenarioUnit = {
  scenarioId: "s1_gp_appointment",
  title: "Booking a GP appointment",
  esolLevelRange: ["Entry 1", "Entry 2", "Entry 3"],
  skillCodes: ["Sc", "Lr", "Rw"],
  vocabulary: [
    {
      word: "appointment",
      definition: "A planned time to meet someone, especially a doctor",
      translations: { ar: "موعد", so: "ballan", fa: "وقت ملاقات", ti: "ቆጸራ", zh: "預約" },
      exampleSentence: "I would like to book an appointment with the doctor.",
    },
    {
      word: "receptionist",
      definition: "The person who answers calls and books appointments at the GP surgery",
      translations: { ar: "موظف الاستقبال", so: "soo dhoweeyaha", fa: "پذیرش", ti: "ተቐባሊት", zh: "接待員" },
    },
    {
      word: "symptoms",
      definition: "How you feel when you are unwell — for example a cough or pain",
      translations: { ar: "أعراض", so: "calaamadaha", fa: "علائم", ti: "ምልክታት", zh: "症狀" },
    },
    {
      word: "available",
      definition: "Possible to have or use",
      translations: { ar: "متاح", so: "la heli karo", fa: "موجود", ti: "ዘሎ", zh: "有空" },
    },
    {
      word: "prescription",
      definition: "A note from the doctor to get medicine",
      translations: { ar: "وصفة طبية", so: "warqad daawo", fa: "نسخه", ti: "ትእዛዝ መድሃኒት", zh: "處方" },
    },
    {
      word: "surgery",
      definition: "The building where GPs see patients",
      translations: { ar: "العيادة", so: "rugta dhakhtarka", fa: "مطب", ti: "ቤት ሕክምና", zh: "診所" },
    },
  ],
  grammarTargets: ["modal verbs: would like to, can I", "polite requests"],
  modelDialogue:
    "Receptionist: Hello, how can I help you?\nLearner: Hello. I would like to book an appointment.\nReceptionist: With which doctor?\nLearner: With Dr Smith, please.\nReceptionist: We have Tuesday at 10 a.m. or Thursday at 3 p.m.\nLearner: Tuesday at 10 a.m. is good for me.\nReceptionist: What is your name?\nLearner: My name is [name].\nReceptionist: And your date of birth?\nLearner: It is the [date].\nReceptionist: Thank you. You are booked for Tuesday at 10 a.m.\nLearner: Thank you very much.",
  roleplayPrompt:
    "You are roleplaying a receptionist at a GP surgery. The learner is calling to book an appointment. Greet warmly, ask what they need, offer two appointment times, ask for their name and date of birth, confirm the booking. Keep your turns short and clear at the learner's level. Praise specific words they use correctly.",
  comprehensionQuestions: [
    { q: "What do you say to ask for an appointment?", modelAnswer: "I would like to book an appointment, please." },
    { q: "What does the receptionist ask for to book the appointment?", modelAnswer: "Your name and date of birth." },
    { q: "What is a symptom?", modelAnswer: "How you feel when you are unwell, like a cough or pain." },
  ],
  passThreshold: 0.7,
  culturalNotes:
    "In the UK, GPs (General Practitioners) are the first point of contact for non-emergency healthcare. To register, a learner usually needs proof of address. NHS numbers are issued at registration. Calling 111 is for non-emergencies, 999 for emergencies.",
  vocabularyReinforcementWeight: 1.0,
};

export const S2_PAYSLIP: ScenarioUnit = {
  scenarioId: "s2_payslip",
  title: "Understanding a payslip",
  esolLevelRange: ["Entry 2", "Entry 3", "Level 1"],
  skillCodes: ["Rt", "Rs", "Rw", "Ww"],
  vocabulary: [
    {
      word: "gross pay",
      definition: "The total money you earn before tax is taken away",
      translations: { ar: "الراتب الإجمالي", so: "mushaharka guud", fa: "حقوق ناخالص", ti: "ድምር ደመወዝ", zh: "稅前工資" },
    },
    {
      word: "net pay",
      definition: "The money you receive after tax — what goes into your bank",
      translations: { ar: "صافي الراتب", so: "mushaharka saafiga ah", fa: "حقوق خالص", ti: "ጽሩይ ደመወዝ", zh: "實領工資" },
    },
    {
      word: "tax",
      definition: "Money the government takes from your pay",
      translations: { ar: "ضريبة", so: "canshuur", fa: "مالیات", ti: "ግብሪ", zh: "稅" },
    },
    {
      word: "National Insurance",
      definition: "Money taken from your pay for the NHS and pension",
      translations: { ar: "التأمين الوطني", so: "Caymiska Qaranka", fa: "بیمه ملی", ti: "ሃገራዊ ኢንሹራንስ", zh: "國民保險" },
    },
    {
      word: "deduction",
      definition: "Money taken away from your pay",
      translations: { ar: "خصم", so: "ka jarid", fa: "کسر", ti: "ምቕናስ", zh: "扣除" },
    },
    {
      word: "HMRC",
      definition: "His Majesty's Revenue and Customs — the UK tax office",
      translations: { ar: "هيئة الإيرادات والجمارك", so: "Xafiiska Canshuuraha UK", fa: "اداره مالیات بریتانیا", ti: "ቤት ጽሕፈት ግብሪ", zh: "英國稅務海關總署" },
    },
    {
      word: "payslip",
      definition: "The paper or digital document that shows your pay",
      translations: { ar: "قسيمة الراتب", so: "warqada mushaharka", fa: "فیش حقوقی", ti: "ቅብሊት ደመወዝ", zh: "工資單" },
    },
  ],
  grammarTargets: ["question forms", "comparative: more than / less than"],
  modelDialogue:
    "Tutor: I have a payslip here. Your gross pay was £1,500. Your net pay is £1,200. What happened to the £300?\nLearner: Maybe tax?\nTutor: Yes, exactly. Tax took some money. National Insurance took some money. These are called deductions.\nLearner: Who takes the tax?\nTutor: HMRC — the UK tax office. They use the money for the NHS and other services.",
  roleplayPrompt:
    "Help the learner understand a sample UK payslip with gross pay £1,500, tax £200, NI £100, net pay £1,200. Use the vocabulary naturally. Ask the learner to identify the figures. Recast errors. Praise specifically when they use new words correctly.",
  comprehensionQuestions: [
    { q: "What is the difference between gross pay and net pay?", modelAnswer: "Gross pay is the total before tax. Net pay is what you receive after tax." },
    { q: "What is HMRC?", modelAnswer: "His Majesty's Revenue and Customs — the UK tax office." },
    { q: "Why is National Insurance taken from your pay?", modelAnswer: "It pays for the NHS and the state pension." },
  ],
  passThreshold: 0.7,
  culturalNotes:
    "UK payslips show pay in pounds (£). Tax codes determine how much tax is taken. Most workers pay tax through PAYE (Pay As You Earn). Workers earning above the personal allowance pay tax.",
  vocabularyReinforcementWeight: 1.0,
};

export const S3_HOUSING: ScenarioUnit = {
  scenarioId: "s3_housing",
  title: "Asking about housing rights",
  esolLevelRange: ["Entry 2", "Entry 3", "Level 1"],
  skillCodes: ["Sc", "Sd", "Rt"],
  vocabulary: [
    { word: "tenancy", definition: "The legal agreement to rent a home", translations: { ar: "إيجار", so: "kirayn", fa: "اجاره", ti: "ክራይ", zh: "租約" } },
    { word: "deposit", definition: "Money you pay at the start, returned at the end if no damage", translations: { ar: "وديعة", so: "deebaaji", fa: "ودیعه", ti: "ጥረዛ", zh: "押金" } },
    { word: "landlord", definition: "The person or company who owns the home you rent", translations: { ar: "مالك العقار", so: "mulkiile", fa: "صاحبخانه", ti: "ዋና ቤት", zh: "房東" } },
    { word: "repairs", definition: "Fixing things that are broken", translations: { ar: "إصلاحات", so: "dayactir", fa: "تعمیرات", ti: "ጽገና", zh: "維修" } },
    { word: "notice period", definition: "The time you must give before leaving — usually 1 month", translations: { ar: "فترة الإشعار", so: "muddo ogeysiis", fa: "مدت اخطار", ti: "ግዜ ምልክታ", zh: "通知期" } },
    { word: "council", definition: "The local government office", translations: { ar: "المجلس البلدي", so: "gole degmo", fa: "شورای محلی", ti: "ምምሕዳር", zh: "市議會" } },
    { word: "housing benefit", definition: "Money the government gives to help pay rent", translations: { ar: "إعانة السكن", so: "kaalmo guriyeyn", fa: "کمک هزینه مسکن", ti: "ሓገዝ ቤት", zh: "住房補貼" } },
  ],
  grammarTargets: ["modal verbs: must, should, have to", "rights and obligations"],
  modelDialogue:
    "Learner: I have a problem. The window in my flat is broken.\nTutor: I am sorry to hear that. Who is your landlord?\nLearner: A company. They do not answer.\nTutor: You have rights. The landlord must repair the window. You can call the council if the landlord does not respond.\nLearner: How much time?\nTutor: Usually 14 days for repairs. Keep records of when you contacted them.",
  roleplayPrompt:
    "Help the learner discuss a housing problem (broken window, mould, deposit dispute, or notice period). Explain UK tenant rights using simple language. Use the vocabulary. Reassure them — many UK tenants have similar concerns.",
  comprehensionQuestions: [
    { q: "Who must repair the home?", modelAnswer: "The landlord — they have a legal duty to keep the home in good repair." },
    { q: "What is housing benefit?", modelAnswer: "Money from the government to help pay rent if you are on a low income." },
    { q: "How long is a typical notice period?", modelAnswer: "Usually 1 month for tenants, 2 months for landlords." },
  ],
  passThreshold: 0.7,
  culturalNotes:
    "UK tenants have legal rights: deposit must be in a government scheme; landlord must keep the home safe and in repair; eviction must follow legal process. Citizens Advice (citizensadvice.org.uk) is a free resource.",
  vocabularyReinforcementWeight: 1.0,
};

export const S4_TRANSPORT: ScenarioUnit = {
  scenarioId: "s4_transport",
  title: "Using public transport",
  esolLevelRange: ["Entry 1", "Entry 2", "Entry 3"],
  skillCodes: ["Lr", "Sc"],
  vocabulary: [
    { word: "timetable", definition: "A list of times when buses or trains run", translations: { ar: "الجدول الزمني", so: "jadwal", fa: "جدول زمانی", ti: "ጊዜ ሰሌዳ", zh: "時刻表" } },
    { word: "single", definition: "A one-way ticket", translations: { ar: "ذهاب فقط", so: "hal jiho", fa: "یک طرفه", ti: "ሓደ መንገዲ", zh: "單程" } },
    { word: "return", definition: "A two-way ticket — go and come back", translations: { ar: "ذهاب وعودة", so: "tagid iyo soo noqod", fa: "رفت و برگشت", ti: "ምምላስ", zh: "往返" } },
    { word: "platform", definition: "Where you wait for the train", translations: { ar: "الرصيف", so: "barxadda", fa: "سکو", ti: "መቐመጢ", zh: "月台" } },
    { word: "delay", definition: "When the train or bus is late", translations: { ar: "تأخير", so: "daahid", fa: "تاخیر", ti: "ምድንጓይ", zh: "延誤" } },
    { word: "Oyster card", definition: "A card you tap to pay for buses and trains in London", translations: { ar: "بطاقة أويستر", so: "kaarka Oyster", fa: "کارت اویستر", ti: "ካርዲ ኦይስተር", zh: "牡蠣卡" } },
  ],
  grammarTargets: ["prepositions of place and time", "imperatives"],
  modelDialogue:
    "Learner: One ticket to Manchester, please.\nClerk: Single or return?\nLearner: Single, please.\nClerk: That is £25. Platform 4. The train leaves in 10 minutes.\nLearner: Thank you.",
  roleplayPrompt:
    "Roleplay buying a ticket, asking for directions, or understanding a delay announcement. Use UK-specific vocabulary like Oyster, return, platform.",
  comprehensionQuestions: [
    { q: "What is the difference between a single and a return?", modelAnswer: "Single is one-way. Return is there and back." },
    { q: "Where do you wait for a train?", modelAnswer: "On the platform." },
  ],
  passThreshold: 0.7,
  culturalNotes:
    "London uses Oyster cards or contactless. Outside London, buses often take cash or contactless. Train tickets cheaper if booked in advance. Always check the platform number — they can change.",
  vocabularyReinforcementWeight: 1.0,
};

export const S5_WORKPLACE: ScenarioUnit = {
  scenarioId: "s5_workplace",
  title: "Workplace communication",
  esolLevelRange: ["Entry 3", "Level 1", "Level 2"],
  skillCodes: ["Sc", "Sd", "Wt"],
  vocabulary: [
    { word: "shift", definition: "Your working hours — for example morning shift or night shift", translations: { ar: "وردية", so: "shaqo", fa: "شیفت", ti: "ስራሕ ግዜ", zh: "輪班" } },
    { word: "manager", definition: "The person who is in charge of you at work", translations: { ar: "مدير", so: "maamule", fa: "مدیر", ti: "ኣካያዲ", zh: "經理" } },
    { word: "colleague", definition: "A person you work with", translations: { ar: "زميل", so: "saaxiib shaqo", fa: "همکار", ti: "ብጻይ ስራሕ", zh: "同事" } },
    { word: "break", definition: "A short rest from work", translations: { ar: "استراحة", so: "nasasho", fa: "استراحت", ti: "ዕረፍቲ", zh: "休息" } },
    { word: "overtime", definition: "Extra hours you work, often paid more", translations: { ar: "العمل الإضافي", so: "shaqo dheeraad", fa: "اضافه کاری", ti: "ተወሳኺ ስራሕ", zh: "加班" } },
    { word: "rota", definition: "The work schedule showing who works when", translations: { ar: "جدول العمل", so: "jadwalka shaqada", fa: "برنامه کاری", ti: "ሰሌዳ ስራሕ", zh: "排班表" } },
    { word: "sick leave", definition: "Time off work because you are unwell", translations: { ar: "إجازة مرضية", so: "fasax xanuun", fa: "مرخصی استعلاجی", ti: "ዕረፍቲ ሕማም", zh: "病假" } },
  ],
  grammarTargets: ["polite requests", "conditional: if I... could you...", "reported speech"],
  modelDialogue:
    "Learner: Excuse me, I am not feeling well today. Could I leave early?\nManager: I am sorry to hear that. Yes, you can. Please send a message to HR. Are you okay?\nLearner: I think I have a cold.\nManager: Take care. Get well soon.",
  roleplayPrompt:
    "Roleplay a workplace scenario: requesting time off, calling in sick, asking about a rota change, or speaking with a colleague. Practise polite UK workplace register.",
  comprehensionQuestions: [
    { q: "How do you politely ask for time off?", modelAnswer: "Excuse me, could I... or I would like to ask if I can..." },
    { q: "What is a rota?", modelAnswer: "The schedule showing who works when." },
  ],
  passThreshold: 0.75,
  culturalNotes:
    "UK workplace culture values politeness and indirect requests. Saying 'please' and 'could you' is expected. Sick pay rules vary by employer; statutory sick pay (SSP) requires 4+ days off. Health & Safety is a legal duty for employers.",
  vocabularyReinforcementWeight: 1.0,
};

export const ALL_SCENARIOS: Record<string, ScenarioUnit> = {
  s1_gp_appointment: S1_GP_APPOINTMENT,
  s2_payslip: S2_PAYSLIP,
  s3_housing: S3_HOUSING,
  s4_transport: S4_TRANSPORT,
  s5_workplace: S5_WORKPLACE,
};
