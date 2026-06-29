const WHOP_API_BASE = "https://api.whop.com/api/v1";
const COMPANY_ID = "biz_3nnlQBMvlGpu8C";
const UPSELL_PLAN_ID = "plan_0NEU5cMLFnWAP";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function getWhopObject(payload) {
  return payload && typeof payload === "object" && payload.data ? payload.data : payload;
}

function getPaymentMethodId(payment) {
  const id =
    payment?.payment_method?.id ||
    payment?.paymentMethod?.id ||
    payment?.payment_method_id ||
    payment?.paymentMethodId;

  return typeof id === "string" ? id : "";
}

function getMemberId(payment) {
  const id =
    payment?.member?.id ||
    payment?.member_id ||
    payment?.user?.id ||
    payment?.user_id;

  return typeof id === "string" ? id : "";
}

async function whopRequest(env, path, options = {}) {
  const response = await fetch(`${WHOP_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.WHOP_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  let payload = null;
  const text = await response.text();

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      payload?.error ||
      `Whop API returned ${response.status}`;

    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }

  return getWhopObject(payload);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        {
          success: false,
          error: "Method not allowed. Send a POST request with a payment_id.",
        },
        405,
      );
    }

    if (!env.WHOP_API_KEY) {
      return jsonResponse(
        {
          success: false,
          error: "Server is missing WHOP_API_KEY. Add it as an encrypted Cloudflare Worker secret.",
        },
        500,
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(
        {
          success: false,
          error: "Invalid JSON body. Send { \"payment_id\": \"pay_xxx\" }.",
        },
        400,
      );
    }

    const paymentId = String(body?.payment_id || body?.paymentId || "").trim();

    if (!paymentId) {
      return jsonResponse(
        {
          success: false,
          error: "Missing payment_id. The upsell page must receive ?payment_id=pay_xxx from the initial Whop checkout.",
        },
        400,
      );
    }

    try {
      const initialPayment = await whopRequest(env, `/payments/${encodeURIComponent(paymentId)}`);
      const memberId = getMemberId(initialPayment);
      const paymentMethodId = getPaymentMethodId(initialPayment);

      if (!memberId) {
        return jsonResponse(
          {
            success: false,
            error: "Could not find member_id on the initial payment. Expected payment.member.id, with fallback to payment.user.id.",
          },
          422,
        );
      }

      if (!paymentMethodId) {
        return jsonResponse(
          {
            success: false,
            error: 'Card was not saved on the initial checkout. The most common cause is missing data-whop-checkout-setup-future-usage="off_session" on the checkout embed.',
          },
          422,
        );
      }

      if (!paymentMethodId.startsWith("payt_")) {
        return jsonResponse(
          {
            success: false,
            error: `Invalid payment_method_id "${paymentMethodId}". Expected a saved Whop payment method id beginning with payt_.`,
          },
          422,
        );
      }

      const charge = await whopRequest(env, "/payments", {
        method: "POST",
        body: JSON.stringify({
          company_id: COMPANY_ID,
          member_id: memberId,
          payment_method_id: paymentMethodId,
          plan_id: UPSELL_PLAN_ID,
        }),
      });

      return jsonResponse({
        success: true,
        charge_id: charge?.id || charge?.payment?.id || null,
        status: charge?.status || charge?.payment?.status || "created",
        charge,
      });
    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: error?.message || "Unable to process the upsell payment.",
        },
        500,
      );
    }
  },
};
