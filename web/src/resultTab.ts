// The Result tab's identity, shared by the card that deep-links to it and the
// task page that renders it. It rides the same ?stage= query param the stage
// chain uses, so a refresh or a shared link lands back on it; the
// chain's selection (detailNav.tsx) ignores an id it does not know, so this one
// never leaks into it.
export const RESULT_TAB_ID = 'result'
