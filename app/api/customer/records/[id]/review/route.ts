import { z } from "zod";
import { ReviewError, submitVisitReview, type ReviewErrorCode } from "@/lib/agents/customer/review";
import { customerContext, errorResponse, readJson } from "../../../_lib/context";

export const dynamic = "force-dynamic";

const ReviewBodySchema = z.object({
  rating: z.number().int().min(1).max(5),
  text: z.string().max(300).optional(),
});

const STATUS: Record<ReviewErrorCode, number> = {
  not_found: 404,
  invalid_request: 400,
  not_reviewable: 409,
  no_record_wallet: 409,
  no_visit_ticket: 409,
  already_reviewed: 409,
  review_rejected: 422,
  review_failed: 502,
  zk_unavailable: 503,
  platform_unavailable: 503,
};

/** 후기 제출 (02 P0, ZK): one review of a clinic-confirmed, anchored visit, through platform.submit_review. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await customerContext(request);
  if (ctx instanceof Response) return ctx;
  try {
    const { id } = await params;
    const body = await readJson(request, ReviewBodySchema);
    return Response.json({ review: await submitVisitReview(ctx.deps, ctx.profile.id, id, body) });
  } catch (error) {
    if (error instanceof ReviewError) return Response.json({ error: error.code, message: error.message }, { status: STATUS[error.code] });
    return errorResponse(error);
  }
}
