import { createPaymentLink, getPayment, payosEnabled, cancelPaymentLink } from "./payos.js";
import { createCheckout, expireCheckout, getCheckout, refundCheckout, stripeEnabled } from "./stripe.js";
import { paymentKeys } from "./credentials.js";

// One interface over the payment gateways, so the booking, wallet and extension flows do not care which one a customer pays with.
//   enabled()                       true when the gateway has its keys
//   createLink(order)               -> { checkoutUrl, externalId }  (order: { orderCode, amount, description, returnUrl, cancelUrl, expiredAt })
//   getPayment(orderRow)            -> { status, paid, closed, amount, amountPaid }
//   closeLink(orderRow)             best effort, stops the link being paid
//   refund(orderRow, amount, key)   -> { id }, only on gateways that can send money back (canRefund)

export const PROVIDERS = {
  payos: {
    name: "payOS",
    canRefund: false,
    enabled: payosEnabled,
    createLink: async (order) => {
      const link = await createPaymentLink(order);
      return { checkoutUrl: link.checkoutUrl, externalId: link.paymentLinkId ?? null };
    },
    getPayment: (order) => getPayment(order.order_code),
    closeLink: (order) => cancelPaymentLink(order.order_code),
  },
  stripe: {
    name: "Stripe",
    canRefund: true,
    enabled: stripeEnabled,
    createLink: (order) => createCheckout({ ...order, now: Date.now() }),
    getPayment: (order) => getCheckout(order.external_id),
    closeLink: (order) => expireCheckout(order.external_id),
    refund: (order, amount, key) => refundCheckout(order.external_id, amount, key),
  },
};

export const providerNames = Object.keys(PROVIDERS);
export const anyProviderEnabled = () => providerNames.some((p) => PROVIDERS[p].enabled());
export const enabledProviders = () => providerNames.filter((p) => PROVIDERS[p].enabled());

// The gateway used for a new payment: the configured one when it is switched on, otherwise the first one that is
export function defaultProvider() {
  const wanted = paymentKeys().provider;
  if (wanted && PROVIDERS[wanted]?.enabled()) return wanted;
  return enabledProviders()[0] ?? null;
}
