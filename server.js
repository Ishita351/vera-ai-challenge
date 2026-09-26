const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const startedAt = Date.now();

/*
 * Context store
 *
 * {
 *   category: Map<context_id, {version, payload}>,
 *   merchant: Map<context_id, {version, payload}>,
 *   customer: Map<context_id, {version, payload}>,
 *   trigger: Map<context_id, {version, payload}>
 * }
 */
const contexts = {
  category: new Map(),
  merchant: new Map(),
  customer: new Map(),
  trigger: new Map()
};

/*
 * GET /v1/healthz
 */
app.get("/v1/healthz", (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

  res.status(200).json({
    status: "ok",
    uptime_seconds: uptimeSeconds,
    contexts_loaded: {
      category: contexts.category.size,
      merchant: contexts.merchant.size,
      customer: contexts.customer.size,
      trigger: contexts.trigger.size
    }
  });
});

/*
 * GET /v1/metadata
 */
app.get("/v1/metadata", (req, res) => {
  res.status(200).json({
    team_name: "Ishita",
    team_members: ["Ishita"],
    model: "deterministic",
    approach: "deterministic merchant-context decision engine",
    contact_email: "",
    version: "0.1.0",
    submitted_at: new Date().toISOString()
  });
});

/*
 * POST /v1/context
 *
 * Stores category / merchant / customer / trigger context.
 *
 * Same version again -> 409 stale_version
 * Higher version -> replace
 * Lower version -> 409 stale_version
 */
app.post("/v1/context", (req, res) => {
  const {
    scope,
    context_id,
    version,
    payload,
    delivered_at
  } = req.body;

  if (
    !scope ||
    !context_id ||
    typeof version !== "number" ||
    payload === undefined
  ) {
    return res.status(400).json({
      accepted: false,
      reason: "invalid_context"
    });
  }

  if (!contexts[scope]) {
    return res.status(400).json({
      accepted: false,
      reason: "invalid_scope"
    });
  }

  const existing = contexts[scope].get(context_id);

  if (existing && version <= existing.version) {
    return res.status(409).json({
      accepted: false,
      reason: "stale_version",
      current_version: existing.version
    });
  }

  contexts[scope].set(context_id, {
    version,
    payload,
    delivered_at
  });

  res.status(200).json({
    accepted: true,
    ack_id: `ack_${context_id}_v${version}`,
    stored_at: new Date().toISOString()
  });
});

/*
 * POST /v1/tick
 *
 * Temporary starter behavior:
 * return no actions.
 *
 * We will replace this with the actual decision engine.
 */
app.post("/v1/tick", (req, res) => {
  res.status(200).json({
    actions: []
  });
});

/*
 * POST /v1/reply
 *
 * Temporary starter behavior.
 */
app.post("/v1/reply", (req, res) => {
  res.status(200).json({
    actions: []
  });
});

/*
 * Unknown route
 */
app.use((req, res) => {
  res.status(404).json({
    error: "not_found"
  });
});

/*
 * IMPORTANT:
 * Render requires binding to 0.0.0.0.
 */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vera bot running on port ${PORT}`);
});