# Visual Improvement Review

This document captures the improvement list from a screenshot-based review of the local app across all primary pages.

## Priority Improvements

1. **Fix Accounts page clipping**
   - The Accounts page cuts off important right-side columns at the current desktop viewport.
   - Improve responsive behavior with horizontal scrolling, pinned important columns, or a narrower column layout.

2. **Split Settings into clearer sections**
   - The page is titled Linked Accounts, but it starts with a large Account Display editing surface.
   - Separate Settings into sections or tabs such as Institutions, Account Display, and Visibility.

3. **Surface linked institution errors earlier**
   - Plaid/institution errors are important but appear far below account display controls.
   - Add connection-health cards or an error summary near the top of Settings.

4. **Move Spending Explorer results higher**
   - The first screen is dominated by filters, chips, and summary cards.
   - Collapse advanced filters or move ranked results and charts higher on the page.

5. **Simplify overloaded history controls**
   - Ticker History and Account History have too many ticker/account chips and legend entries.
   - Add search-first selection, grouped account filters, or collapsed overflow sections.

6. **Clarify duplicate ticker labels**
   - Ticker History can show repeated labels such as AMZN from different accounts.
   - Disambiguate by account or aggregate duplicate tickers intentionally.

7. **Improve Dashboard hierarchy**
   - The Refresh button is full-width and visually competes with core portfolio information.
   - Make Refresh a compact action and tighten the allocation/chart layout.

8. **Reduce empty space on simple table pages**
   - Cash and Liabilities leave a large amount of unused vertical space.
   - Add recent balance changes, sync status, account notes, or small trend summaries.

9. **Strengthen chart labels and explanations**
   - Spending Analytics, Account History, and the spending heatmap need clearer context.
   - Improve legends, axis labels, and short chart captions where interpretation is not obvious.

10. **Improve table responsiveness across the app**
    - Assets, Accounts, Dashboard details, and Monthly Expenses are dense and can feel cramped.
    - Use horizontal table containers, pinned name/value columns, or page-specific column pruning.

11. **Reduce repetitive Settings row actions**
    - Repeated Save, Clear, and Visible controls create a long wall of similar controls.
    - Prefer inline edit mode, row dirty states, and bulk save where possible.

12. **Add row actions and cleanup affordances to Monthly Expenses**
    - Monthly Expenses does not make edit/delete behavior obvious from the table view.
    - Add visible row actions and improve data hygiene around free-form bill names.

## Page-by-Page Improvements

Current screenshot pass: all pages below rendered successfully in an authenticated local Chrome session on July 8, 2026.

### Dashboard

1. Compress the data-health warning so it does not dominate the first screen more than the net-worth and allocation content.
2. Add clearer freshness context to the main net-worth delta, such as the comparison baseline and latest snapshot date.
3. Rebalance the asset-allocation panel so the donut, legend, and percentages feel like one composed chart instead of separate blocks.
4. Make Account Feed sparklines more interpretable with hover values, mini-axis context, or clearer 30-day change labels.
5. Bring the Portfolio Details table higher or shorten the dashboard panels above it so key holdings are visible sooner.

### Assets

1. Hide or simplify duplicate summary cards when Total Assets, Visible Total, Category Total, and Account Total all show the same value.
2. Reduce the vertical height of the filter panel when only a few category/account chips are available.
3. Treat "Linked" as status rather than the only row action; add clear details, edit, and categorize actions where applicable.
4. Improve long account and security names with better truncation, tooltips, or a secondary metadata line.
5. Add a bulk cleanup path for uncategorized assets, since many rows currently repeat the same category state.

### Cash

1. Align the main cash total and the Accounts/Freshness/Add Entry controls into a more unified header system.
2. De-emphasize zero-balance cash accounts or place them in a separate collapsed group.
3. Replace duplicated account cards plus table rows with a trend, balance-change, or cash-flow summary in one of those spaces.
4. Rename or clarify "Status Mix 4/4" so it explains linked, active, or fresh account coverage at a glance.
5. Strengthen account identity with institution grouping, clearer nicknames, and more prominent last-updated labels.

### Liabilities

1. Add payoff context near the headline total, such as minimum payment, utilization, interest rate, or payoff priority.
2. Make credit-card and loan group headers more informative with subtotals, counts, and stale/manual account indicators.
3. Reduce duplicate account filtering, grouped cards, and table rows so the page does not repeat the same liability list three ways.
4. Make manual and stale liability rows more visible, especially when they influence the total.
5. Use more nuanced balance styling than red-only owed amounts, such as risk level, utilization, or payment urgency.

### Accounts

1. Reduce the oversized top value/filter area so more account rows appear in the first viewport.
2. Move inactive-account controls into the main filter toolbar instead of a separate card embedded in the filter panel.
3. Add visible row-level actions for details, edit display name, hide, or inspect linked data.
4. Improve very long account names with better wrapping, nickname emphasis, and institution metadata.
5. Show sync health, stale status, and data-source state directly in each account row.

### Ticker History

1. Replace the ticker chip wall with a searchable selector plus a compact selected-tickers overflow area.
2. Standardize duplicate ticker labels so account-specific and aggregate tickers are visibly different.
3. Add a selected-series summary with current value, period change, and best/worst performer.
4. Use the large empty area below the chart for a data table, selected ticker cards, or explanatory context.
5. Make the legend interactive so users can temporarily hide/show lines without changing the selection chips.

### Account History

1. Collapse the selected account chip area when many accounts are active so controls do not overtake the chart.
2. Add account-type or institution grouping to the account selector for faster scanning.
3. Improve readability when values are on different scales, for example with normalized view, split panels, or hide-small-series mode.
4. Move the oversized legend into a scrollable side panel or series table.
5. Clarify limited data availability when a selected range renders only a few dates.

### Portfolio Timeline

1. Tighten the metrics and chart-mode controls into a single chart header so the chart has less surrounding chrome.
2. Make Trend Line and Drawdown feel like true chart modes with clearer active-state copy and placement.
3. Add richer annotations for major peaks, drawdowns, and starting/ending values.
4. Move Export CSV into a less prominent actions menu once the user is focused on analysis.
5. Use the empty space below the chart for notable events, monthly deltas, or a compact period-change table.

### Holdings Analysis

1. Add a visible color legend for the treemap so account/category grouping is understandable without hovering.
2. Reduce the oversized Largest Holding metric typography so the holding name, ticker, and value fit more cleanly.
3. Improve tiny treemap tile labels with hover details, a side inspector, or minimum readable label rules.
4. Combine the Treemap/Waterfall/Allocation and Account/Category/Type controls into one clearer analysis toolbar.
5. Bring exact top-holding values alongside the treemap instead of pushing the details table below the fold.

### Spending

1. Combine the detached date-range card with the period controls so the selected window is easier to understand.
2. Split or clarify the dual-axis Income vs Everyday Spend chart so savings-rate interpretation is less error-prone.
3. Shorten the first chart or use a side summary so category breakdowns are not mostly below the first viewport.
4. Add drilldowns from chart bars, donut segments, and top-category rows to the underlying transactions.
5. Use clearer category label wrapping for long labels in the Top Categories chart.

### Spending Explorer

1. Keep common filters visible but collapse secondary filters so the chart and ranked list remain the first-screen focus.
2. Add expandable transaction detail rows inside the Ranked list so users can inspect a merchant without leaving the page.
3. Improve long merchant labels in the bar chart with smarter truncation, wrapping, and hover labels.
4. Make the hidden non-purchase outflows chip actionable with a direct include/exclude toggle.
5. Tie Stores/Kinds/Categories modes more tightly to the chart title, ranking labels, and empty states.

### Year in Review

1. Label 2026 metrics as year-to-date or partial-year where appropriate so prior-year comparisons are fair.
2. Break the narrative summary into highlighted drivers, such as best month, worst month, income, spend, and savings rate.
3. Explain missing future months in the monthly chart instead of leaving an apparent six-month year.
4. Add event or account-change annotations to the largest monthly net-worth swings.
5. Preview the below-fold section sequence so users know where to find trajectory, allocation, and cash-flow details.

### Salary History

1. Reduce the large empty margins by aligning the page width and header rhythm with the rest of the analytics pages.
2. Group Career Growth and Add Record closer to the headline compensation figure.
3. Add milestone annotations directly on the compensation trajectory chart for title changes and major raises.
4. Expand the compensation mix card with clearer base, bonus, and equity definitions.
5. Add visible edit/delete actions and a year-over-year summary to the Career History table.

### Monthly Expenses

1. Add visible row actions for edit, delete, duplicate, archive, or mark inactive.
2. Flag rough/free-form bill names for cleanup so the expense list feels polished and trustworthy.
3. Add due date, last paid, or payment confidence columns to make the table operational, not just descriptive.
4. Show fixed, variable, subscription, and detected-category totals together in a clearer cost breakdown.
5. Use the empty lower area for upcoming bills, monthly burn-rate trend, or annualized category impact.

## Global Observations

- The dark, dense visual style is consistent, but many pages need stronger hierarchy to guide attention.
- The collapsed icon-only sidebar is compact, but the expanded label version is easier to scan.
- Several pages would benefit from clearer empty-space usage and more purposeful first-screen composition.
- The app is strongest when charts and summaries are paired with actionable details in the same viewport.
