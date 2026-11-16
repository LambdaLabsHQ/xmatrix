package sh.xmatrix.app;

import android.net.Uri;
import com.android.billingclient.api.AccountIdentifiers;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Google Play subscriptions for the trusted web page. The page asks the Hub
 * for an account token, buys with it here, and hands the purchase token back
 * to the Hub, which verifies and acknowledges it with Google. Nothing here
 * decides entitlement.
 */
final class PlayBilling {
  private static final String PACKAGE = "sh.xmatrix.app";
  private final MainActivity activity;
  private final BillingClient client;
  /** The purchase waiting for Google Play's answer; one at a time. */
  private Consumer<String> pendingPurchase;

  PlayBilling(MainActivity activity) {
    this.activity = activity;
    this.client = BillingClient.newBuilder(activity)
      .setListener(this::purchasesUpdated)
      .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
      .enableAutoServiceReconnection()
      .build();
  }

  /** Base plans of one subscription with their localized price. */
  void products(JSONObject payload, Consumer<String> reply) {
    String subscriptionId = validId(payload.optString("subscriptionId", ""));
    if (subscriptionId == null) { reply.accept(NativeBridge.failureJson("Subscription products are unavailable.")); return; }
    details(subscriptionId, reply, product -> {
      JSONArray plans = new JSONArray();
      for (ProductDetails.SubscriptionOfferDetails offer : baseOffers(product)) {
        List<ProductDetails.PricingPhase> phases = offer.getPricingPhases().getPricingPhaseList();
        if (phases.isEmpty()) continue;
        plans.put(new JSONObject().put("basePlanId", offer.getBasePlanId())
          .put("displayPrice", phases.get(phases.size() - 1).getFormattedPrice()));
      }
      reply.accept(NativeBridge.successJson(plans));
    });
  }

  void purchase(JSONObject payload, Consumer<String> reply) {
    String subscriptionId = validId(payload.optString("subscriptionId", ""));
    String basePlanId = validId(payload.optString("basePlanId", ""));
    String accountToken = payload.optString("accountToken", "");
    if (subscriptionId == null || basePlanId == null || !accountToken.matches("[0-9a-fA-F-]{36}")) {
      reply.accept(NativeBridge.failureJson("The subscription purchase could not be prepared."));
      return;
    }
    details(subscriptionId, reply, product -> {
      ProductDetails.SubscriptionOfferDetails chosen = null;
      for (ProductDetails.SubscriptionOfferDetails offer : baseOffers(product)) {
        if (basePlanId.equals(offer.getBasePlanId())) chosen = offer;
      }
      if (chosen == null) { reply.accept(NativeBridge.failureJson("This subscription is not available in Google Play.")); return; }
      BillingFlowParams params = BillingFlowParams.newBuilder()
        .setProductDetailsParamsList(Collections.singletonList(BillingFlowParams.ProductDetailsParams.newBuilder()
          .setProductDetails(product).setOfferToken(chosen.getOfferToken()).build()))
        // The Hub reads this back from Google to find the owner and Space.
        .setObfuscatedAccountId(accountToken.toLowerCase())
        .build();
      activity.runOnUiThread(() -> {
        if (pendingPurchase != null) { reply.accept(NativeBridge.failureJson("A purchase is already in progress.")); return; }
        pendingPurchase = reply;
        BillingResult launched = client.launchBillingFlow(activity, params);
        if (launched.getResponseCode() != BillingClient.BillingResponseCode.OK) {
          pendingPurchase = null;
          reply.accept(failure(launched));
        }
      });
    });
  }

  /** Subscriptions this Google account holds now, including ones awaiting payment. */
  void purchases(JSONObject payload, Consumer<String> reply) {
    String subscriptionId = validId(payload.optString("subscriptionId", ""));
    if (subscriptionId == null) { reply.accept(NativeBridge.failureJson("Subscription products are unavailable.")); return; }
    connected(reply, () -> client.queryPurchasesAsync(
      QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build(),
      (result, list) -> {
        if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) { reply.accept(failure(result)); return; }
        try {
          JSONArray out = new JSONArray();
          for (Purchase purchase : list) {
            if (purchase.getProducts().contains(subscriptionId)) out.put(payload(purchase));
          }
          reply.accept(NativeBridge.successJson(out));
        } catch (Exception error) { reply.accept(NativeBridge.failureJson(error.getMessage())); }
      }));
  }

  /** Google Play's own page for this subscription, where renewal is managed. */
  void manage(JSONObject payload) {
    String subscriptionId = validId(payload.optString("subscriptionId", ""));
    Uri.Builder url = Uri.parse("https://play.google.com/store/account/subscriptions").buildUpon();
    if (subscriptionId != null) url.appendQueryParameter("sku", subscriptionId).appendQueryParameter("package", PACKAGE);
    if (!activity.openExternal(url.build())) throw new IllegalStateException("Google Play cannot be opened on this device");
  }

  private void purchasesUpdated(BillingResult result, List<Purchase> purchases) {
    Consumer<String> reply = pendingPurchase;
    pendingPurchase = null;
    // A purchase that completes later (a pending payment) is recovered by the
    // page reading purchases when Billing opens again.
    if (reply == null) return;
    int code = result.getResponseCode();
    try {
      if (code == BillingClient.BillingResponseCode.USER_CANCELED) {
        reply.accept(NativeBridge.successJson(new JSONObject().put("status", "cancelled")));
        return;
      }
      if (code != BillingClient.BillingResponseCode.OK || purchases == null || purchases.isEmpty()) {
        reply.accept(failure(result));
        return;
      }
      Purchase purchase = purchases.get(0);
      boolean done = purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED;
      reply.accept(NativeBridge.successJson(new JSONObject().put("status", done ? "purchased" : "pending").put("purchase", payload(purchase))));
    } catch (Exception error) {
      reply.accept(NativeBridge.failureJson(error.getMessage()));
    }
  }

  private interface ProductAction { void run(ProductDetails product) throws Exception; }

  private void details(String subscriptionId, Consumer<String> reply, ProductAction action) {
    connected(reply, () -> client.queryProductDetailsAsync(
      QueryProductDetailsParams.newBuilder().setProductList(Collections.singletonList(
        QueryProductDetailsParams.Product.newBuilder().setProductId(subscriptionId)
          .setProductType(BillingClient.ProductType.SUBS).build())).build(),
      (result, found) -> {
        if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) { reply.accept(failure(result)); return; }
        List<ProductDetails> list = found.getProductDetailsList();
        if (list.isEmpty()) { reply.accept(NativeBridge.failureJson("This subscription is not available in Google Play.")); return; }
        try { action.run(list.get(0)); }
        catch (Exception error) { reply.accept(NativeBridge.failureJson(error.getMessage())); }
      }));
  }

  private void connected(Consumer<String> reply, Runnable work) {
    if (client.isReady()) { work.run(); return; }
    client.startConnection(new BillingClientStateListener() {
      @Override public void onBillingSetupFinished(BillingResult result) {
        if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) work.run();
        else reply.accept(failure(result));
      }
      @Override public void onBillingServiceDisconnected() {}
    });
  }

  /** Base plans only: offers (trials, discounts) are not sold here. */
  private static List<ProductDetails.SubscriptionOfferDetails> baseOffers(ProductDetails product) {
    List<ProductDetails.SubscriptionOfferDetails> all = product.getSubscriptionOfferDetails();
    List<ProductDetails.SubscriptionOfferDetails> base = new ArrayList<>();
    if (all == null) return base;
    for (ProductDetails.SubscriptionOfferDetails offer : all) if (offer.getOfferId() == null) base.add(offer);
    return base;
  }

  private static JSONObject payload(Purchase purchase) throws Exception {
    AccountIdentifiers ids = purchase.getAccountIdentifiers();
    String account = ids == null || ids.getObfuscatedAccountId() == null ? "" : ids.getObfuscatedAccountId();
    return new JSONObject().put("purchaseToken", purchase.getPurchaseToken())
      .put("productIds", new JSONArray(purchase.getProducts()))
      .put("state", purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED ? "purchased" : "pending")
      .put("accountToken", account);
  }

  private static String validId(String value) {
    return value != null && value.matches("[a-z0-9][a-z0-9._-]{0,99}") ? value : null;
  }

  /** Google Play's own answer, named, so a refusal says what Play said. */
  private static String failure(BillingResult result) {
    String message = result.getDebugMessage();
    return NativeBridge.failureJson("Google Play billing response " + result.getResponseCode()
      + (message == null || message.isEmpty() ? "" : ": " + message));
  }
}
