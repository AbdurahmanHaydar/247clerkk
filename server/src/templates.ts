/**
 * The starters a visitor picks from before they build their own conversation.
 *
 * Each one is a complete, working flow for a vertical this product actually
 * sells to. They exist because a blank builder in front of a cold visitor is a
 * dead end — nobody evaluating a product in ninety seconds wants to compose an
 * intake script from nothing. Pick a trade, adjust a line, go.
 *
 * Every template follows the same shape, which is the shape the visitor-facing
 * builder can edit: a greeting, some questions, one qualified ending and one
 * "not a fit" ending. Anything richer — conditions, jump rules, several
 * branches — belongs in the owner's builder in /admin.
 */

import { type Flow, normalizeFlow } from "./flow.js";

export type Template = {
  id: string;
  name: string;
  tagline: string;
  flow: Flow;
};

/** Ids the public builder relies on. Kept stable so edits round-trip. */
const GREET = "greet";
const DONE = "done";
const NOFIT = "nofit";

type Draft = {
  greeting: string;
  questions: {
    key: string;
    label: string;
    ask: string;
    field?: "text" | "choice" | "email" | "phone" | "number";
    mode?: "ai" | "strict";
    /** A label ending in " (not a fit)" disqualifies — see build(). */
    options?: string[];
  }[];
  done: string;
  nofit: string;
};

function build(draft: Draft): Flow {
  const steps: unknown[] = [
    { id: GREET, type: "message", label: "Greeting", text: draft.greeting, next: "q1" },
  ];

  draft.questions.forEach((question, index) => {
    const options = (question.options ?? []).map((raw) => {
      const disqualifies = raw.endsWith(" (not a fit)");
      const label = disqualifies ? raw.slice(0, -" (not a fit)".length) : raw;
      return { label, value: label, next: disqualifies ? NOFIT : null };
    });

    steps.push({
      id: `q${index + 1}`,
      type: "question",
      label: question.label,
      key: question.key,
      ask: question.ask,
      field: question.field ?? "text",
      mode: question.mode ?? "ai",
      options,
      required: true,
      next: index + 1 < draft.questions.length ? `q${index + 2}` : DONE,
    });
  });

  steps.push({ id: DONE, type: "end", label: "Qualified", outcome: "qualified", text: draft.done });
  steps.push({ id: NOFIT, type: "end", label: "Not a fit", outcome: "unqualified", text: draft.nofit });

  return normalizeFlow({ name: "Intake", start: GREET, steps, onDecline: NOFIT });
}

export const TEMPLATES: Template[] = [
  {
    id: "attorney",
    name: "Attorney",
    tagline: "Sort the urgent matters from the tyre-kickers before Monday.",
    flow: build({
      greeting:
        "Hi — you've reached our after-hours line. I'm the clerk; I'll take a few details and " +
        "one of the attorneys will come back to you.",
      questions: [
        {
          key: "matter_type",
          label: "Matter type",
          ask: "What kind of matter is it — for example an eviction, a divorce, or a contract dispute?",
        },
        {
          key: "urgency",
          label: "Urgency",
          ask: "How soon do you need this dealt with?",
          field: "choice",
          mode: "strict",
          options: ["It's an emergency", "This week", "This month", "Just enquiring (not a fit)"],
        },
        { key: "contact_name", label: "Name", ask: "And who should the attorney ask for when they call?" },
      ],
      done:
        "Thanks{{#name}}, {{name}}{{/name}} — that's everything the attorney needs. " +
        "I've logged it and someone will come back to you first thing.",
      nofit:
        "Thanks for reaching out. We're not taking on general enquiries at the moment, but do get in " +
        "touch when something concrete comes up.",
    }),
  },
  {
    id: "estate-agent",
    name: "Estate agent",
    tagline: "Qualify buyers on budget before you give up a Saturday.",
    flow: build({
      greeting: "Hi! Thanks for your interest. I'll take a few quick details and an agent will call you.",
      questions: [
        {
          key: "intent",
          label: "Buying or selling",
          ask: "Are you looking to buy, to sell, or to rent?",
          field: "choice",
          mode: "strict",
          options: ["Buying", "Selling", "Renting (not a fit)"],
        },
        {
          key: "area",
          label: "Area",
          ask: "Which area are you interested in?",
        },
        {
          key: "budget",
          label: "Budget",
          ask: "Roughly what budget are you working with?",
          field: "number",
        },
        { key: "contact_name", label: "Name", ask: "And who should the agent ask for?" },
      ],
      done:
        "Thanks{{#name}}, {{name}}{{/name}} — an agent will be in touch with " +
        "options that fit.",
      nofit: "Thanks for reaching out — rentals aren't something we handle, but I appreciate the enquiry.",
    }),
  },
  {
    id: "financial-adviser",
    name: "Financial adviser",
    tagline: "Catch the enquiry, and whether it's worth a meeting.",
    flow: build({
      greeting: "Hi — thanks for getting in touch. A few quick questions and an adviser will call you back.",
      questions: [
        {
          key: "goal",
          label: "What they need",
          ask: "What are you hoping to sort out — retirement, investments, insurance, or something else?",
        },
        {
          key: "timeline",
          label: "Timeline",
          ask: "When are you looking to get this moving?",
          field: "choice",
          mode: "strict",
          options: ["Right away", "In the next few months", "Just researching (not a fit)"],
        },
        { key: "contact_name", label: "Name", ask: "And who should the adviser ask for?" },
        { key: "email", label: "Email", ask: "What's the best email for the paperwork?", field: "email" },
      ],
      done:
        "Thanks{{#name}}, {{name}}{{/name}} — an adviser will call you to set up a " +
        "proper conversation.",
      nofit:
        "No problem at all — have a read through our guides in the meantime, and shout when you're ready.",
    }),
  },
  {
    id: "generic",
    name: "Something else",
    tagline: "Three plain questions. Rewrite them to suit your trade.",
    flow: build({
      greeting: "Hi — thanks for messaging. I'll take a few details and someone will come back to you.",
      questions: [
        { key: "enquiry", label: "What they need", ask: "What can we help you with?" },
        { key: "timeline", label: "Timeline", ask: "How soon do you need it?" },
        { key: "contact_name", label: "Name", ask: "And who should we ask for when we call back?" },
      ],
      done:
        "Thanks{{#name}}, {{name}}{{/name}} — I've logged that and someone will " +
        "come back to you.",
      nofit: "No problem at all — message this number any time and I'll pick it straight up.",
    }),
  },
];

export function templateById(id: string | null | undefined): Template | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
