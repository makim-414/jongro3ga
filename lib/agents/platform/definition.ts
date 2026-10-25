// AgentDefinition for the platform agent. OWNER: track A2A core (+ OPS proposer, LLM recipe register their skills here).
import { buildAgentCard, rpcUrlFor } from "../../a2a/cards";
import type { AgentDefinition } from "../../a2a/contract";
import { recipeSkill } from "./recipe";
import { judgeQuoteSkill, matchClinicsSkill, reportBookingSkill, reportSignalSkill, submitOutcomeSkill } from "./skills";
import { anchorRecordSkill, submitReviewSkill } from "./zk-skills";

export const PLATFORM_AGENT_ID = "platform";

export const platformAgent: AgentDefinition = {
  role: "platform",
  async card(_agentId, baseUrl) {
    return buildAgentCard({
      name: "PibooK Platform Agent",
      description:
        "Matches K-beauty clinic requests with clinics using real paid-price records, judges whether a quoted price and dose are fair, and collects post-procedure outcomes.",
      rpcUrl: rpcUrlFor("platform", PLATFORM_AGENT_ID, baseUrl),
      organization: "PibooK",
      baseUrl,
      skills: [
        {
          id: "platform.recipe",
          name: "Korean women procedure recipe",
          description:
            "Returns which procedures Korean women with the same concern and age band actually chose, typical dose, cycle, downtime and onset, from recorded data.",
          tags: ["recipe", "procedure", "data"],
          examples: ['{"schema":"pibu/recipe-query@1","concerns":["elasticity"],"ageBand":"25-29"}'],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "platform.match_clinics",
          name: "Match clinics",
          description: "Ranks up to three clinics for a procedure request and issues a signed referral token per clinic.",
          tags: ["matching", "clinic", "referral"],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "platform.judge_quote",
          name: "Judge quote fairness",
          description: "Judges each quote's unit price and dose against recent verified paid records in the same region.",
          tags: ["price", "fairness", "dose"],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "platform.report_booking",
          name: "Report booking",
          description: "Clinic agents report confirmed bookings with the referral token for attribution.",
          tags: ["booking", "attribution"],
          inputModes: ["application/json"],
          outputModes: ["text/plain"],
        },
        {
          id: "platform.report_signal",
          name: "Report signal",
          description: "Customer agents report clinic response timeouts and rejections observed while requesting quotes.",
          tags: ["signal", "reliability"],
          inputModes: ["application/json"],
          outputModes: ["text/plain"],
        },
        {
          id: "platform.submit_outcome",
          name: "Submit outcome",
          description: "Customer agents submit paid price, received dose and satisfaction after a procedure.",
          tags: ["review", "outcome"],
          inputModes: ["application/json"],
          outputModes: ["text/plain"],
        },
        {
          id: "platform.anchor_record",
          name: "Anchor record",
          description:
            "Verifies that a completed booking belongs to the calling customer agent, then submits the customer wallet's append proof to the record registry as relayer and issues one visit ticket.",
          tags: ["zk", "record", "anchor"],
          inputModes: ["application/json"],
          outputModes: ["text/plain"],
        },
        {
          id: "platform.submit_review",
          name: "Submit verified review",
          description:
            "Accepts one anonymous review per verified visit using a Semaphore proof and adds it to the clinic and procedure aggregate.",
          tags: ["zk", "review", "aggregate"],
          inputModes: ["application/json"],
          outputModes: ["text/plain"],
        },
      ],
    });
  },
  async exists(agentId) {
    return agentId === PLATFORM_AGENT_ID;
  },
  skills: {
    "platform.recipe": recipeSkill,
    "platform.match_clinics": matchClinicsSkill,
    "platform.judge_quote": judgeQuoteSkill,
    "platform.report_booking": reportBookingSkill,
    "platform.submit_outcome": submitOutcomeSkill,
    "platform.report_signal": reportSignalSkill,
    "platform.anchor_record": anchorRecordSkill,
    "platform.submit_review": submitReviewSkill,
  },
};
