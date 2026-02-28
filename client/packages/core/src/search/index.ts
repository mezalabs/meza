export {
  backfillChannel,
  indexIncomingMessage,
  resetSearchState,
} from './indexer.ts';
export {
  clearAllIndexes,
  hasIndex,
  type IndexedMessage,
  indexMessage,
  type LocalSearchResult,
  searchLocal,
} from './local-index.ts';
export {
  type SearchResultItem,
  type SearchState,
  useSearchStore,
} from './store.ts';
