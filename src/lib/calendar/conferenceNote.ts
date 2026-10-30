// Every note a conference-room generation leaves on a CalendarConnection starts
// with this (#2009), so the mirror push — which clears its own errors on success
// — leaves it alone. Its own file so the sync loop and the generator can both
// read it without importing each other.
export const CONFERENCE_NOTE_PREFIX = 'Meeting room generation';
