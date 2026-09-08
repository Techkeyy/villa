/** Read-only book availability. Missing data never manufactures a quote. */
export async function readQuoteBook(read) {
  let book;
  try { book = await read(); }
  catch { return { bids: [], asks: [], unavailable: true }; }
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) {
    return { bids: [], asks: [], unavailable: true };
  }
  return book;
}

export function planAvailableBook(input, book, planner) {
  if (book?.unavailable || (!book?.bids?.length && !book?.asks?.length)) {
    return { plan: "NO_QUOTE", ask: { enabled: false, action: "SELL_YES" }, reasonCode: "BOOK_UNAVAILABLE" };
  }
  return planner(input);
}
