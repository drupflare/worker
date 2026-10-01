/** A value with the time (ms since epoch) it was recorded. */
export interface Stamped<T> {
	at: number;
	value: T;
}
