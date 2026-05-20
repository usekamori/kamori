// page_view is logged by KamoriProvider (browser-side) in layout.tsx
async function getRecentOrders() {
  const expressUrl = process.env.EXPRESS_URL ?? "http://localhost:4000";
  try {
    const res = await fetch(`${expressUrl}/api/orders`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export default async function CheckoutPage() {
  const orders = await getRecentOrders();

  return (
    <main>
      <h1>Kamori Demo — Checkout</h1>
      <p style={{ color: "#666" }}>
        A multi-service observability demo. Every action is logged to Kamori across 6 polyglot services.
      </p>

      <section style={{ marginTop: "2rem" }}>
        <h2>Place an Order</h2>
        <form action="/api/checkout" method="POST" style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: "360px" }}>
          <label>
            Product
            <input
              name="product"
              defaultValue="Widget Pro"
              style={{ display: "block", width: "100%", padding: "0.4rem", marginTop: "0.25rem" }}
            />
          </label>
          <label>
            Amount ($)
            <input
              name="amount"
              type="number"
              defaultValue="49"
              style={{ display: "block", width: "100%", padding: "0.4rem", marginTop: "0.25rem" }}
            />
          </label>
          <label>
            User ID
            <input
              name="userId"
              defaultValue="user-42"
              style={{ display: "block", width: "100%", padding: "0.4rem", marginTop: "0.25rem" }}
            />
          </label>
          <button
            type="submit"
            style={{ padding: "0.6rem 1.2rem", background: "#0070f3", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer" }}
          >
            Checkout
          </button>
        </form>
        <p style={{ fontSize: "0.85rem", color: "#888", marginTop: "0.5rem" }}>
          Tip: try amount &gt; 5000 to trigger a payment error, or submit ~20 times to see an email bounce error.
        </p>
      </section>

      <section style={{ marginTop: "3rem" }}>
        <h2>Recent Orders</h2>
        {Array.isArray(orders) && orders.length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["ID", "Product", "Amount", "Status"].map((h) => (
                  <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #eee", paddingBottom: "0.5rem" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map((o: Record<string, unknown>, i: number) => (
                <tr key={i}>
                  <td style={{ padding: "0.4rem 0" }}>{String(o.id)}</td>
                  <td style={{ padding: "0.4rem 0" }}>{String(o.product)}</td>
                  <td style={{ padding: "0.4rem 0" }}>${String(o.amount)}</td>
                  <td style={{ padding: "0.4rem 0" }}>{String(o.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: "#999" }}>No orders yet — place one above.</p>
        )}
      </section>
    </main>
  );
}
