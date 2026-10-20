import { expect, test } from "@playwright/test";

// Runs the UI against the in-memory demo backend (`?demo`).
test("browse a table and run a query", async ({ page }) => {
  await page.goto("/?demo");
  await expect(page.getByText("Shop — production")).toBeVisible();
  await page.getByText("Shop — production").dblclick();
  await page.getByText("shop", { exact: true }).dblclick();
  await page.getByText("public", { exact: true }).dblclick();
  await page.getByText("Tables", { exact: true }).dblclick();
  await page.getByText("customers", { exact: true }).dblclick();
  await expect(page.getByTestId("result-info")).toContainText("200 rows+");

  await page.keyboard.press("Control+]");
  await page.locator(".cm-content").last().click();
  await page.keyboard.type("select * from orders where total > 800");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("result-tab")).toHaveCount(1);
});

test("create a connection from the dialog", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-connection").click();
  await page.getByTestId("driver-mysql").click();
  await expect(page.getByText("New MySQL connection")).toBeVisible();
  await page.getByLabel("Connection URL").fill("mysql://app:secret@db.example.com:3307/shop");
  await expect(page.getByPlaceholder("localhost")).toHaveValue("db.example.com");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("shop @ db.example.com")).toBeVisible();
});
