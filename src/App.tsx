import {
  lazy,
  Suspense,
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from 'react'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { auth, authReady, db, firebaseEnabled } from './firebase'
import {
  clearStoredAppState,
  readStoredAppState,
  writeStoredAppState,
} from './lib/appState'
import type { CacheEntry } from './lib/cache'
import { getCachedValue, setCachedValue } from './lib/cache'
import './App.css'

const AuthPage = lazy(() => import('./AuthPage'))

type Movie = {
  id: number
  title: string
  overview: string
  poster_path: string | null
  backdrop_path: string | null
  release_date: string
  vote_average: number
  genre_ids?: number[]
}

type SearchMovie = {
  id: number
  title: string
  release_date: string
}

type UserProfile = {
  uid: string
  displayName: string
  email: string
  bio: string
}

type MovieReply = {
  id: string
  commentId: string
  userId: string
  userName: string
  text: string
  createdAtMs: number
}

type MovieComment = {
  id: string
  userId: string
  userName: string
  text: string
  createdAtMs: number
  likes: string[]
  replies: MovieReply[]
}

type MovieRating = {
  userId: string
  userName: string
  value: number
  updatedAtMs: number
}

type MovieDiscussion = {
  comments: MovieComment[]
  ratings: MovieRating[]
}

type MovieDetails = {
  id: number
  title: string
  overview: string
  poster_path: string | null
  backdrop_path: string | null
  release_date: string
  vote_average: number
  runtime: number | null
  genres: Genre[]
  tagline: string
  status: string
}

type MovieDetailBundle = {
  details: MovieDetails
  providers: WatchProviderRegion | null
  cast: CastMember[]
  related: Movie[]
}

type CastMember = {
  id: number
  name: string
  character: string
}

type Provider = {
  provider_id: number
  provider_name: string
}

type WatchProviderRegion = {
  link?: string
  flatrate?: Provider[]
  rent?: Provider[]
  buy?: Provider[]
}

type WatchProvidersResponse = {
  results?: {
    US?: WatchProviderRegion
  }
}

type PersistedAppState = {
  mode: 'compass' | 'seed'
  view: 'recommendations' | 'catalog'
  selectedGenres: number[]
  selectedMood: MoodKey
  selectedEra: EraKey
  seedQuery: string
  selectedSeedMovie: SearchMovie | null
  selectedMovie: Movie | null
  watchlistOverlayOpen: boolean
}

type Genre = {
  id: number
  name: string
}

type MoodKey = 'feel-good' | 'intense' | 'mind-bending' | 'heartfelt'
type EraKey = 'any' | 'recent' | '2010s' | '2000s' | 'classics'

type TmdbFetchOptions = {
  signal?: AbortSignal
}

const DIRECT_API_BASE = 'https://api.themoviedb.org/3'
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500'
const API_KEY = import.meta.env.VITE_TMDB_API_KEY
const USE_DIRECT_TMDB = import.meta.env.DEV && Boolean(API_KEY)
const FALLBACK_POSTER =
  'https://image.tmdb.org/t/p/w500/9gk7adHYeDvHkCSEqAvQNLV5Uge.jpg'
const TMDB_CACHE_TTL_MS = 10 * 60 * 1000
const DETAIL_CACHE_TTL_MS = 15 * 60 * 1000
const MAX_TMDB_CACHE_ENTRIES = 80
const MAX_DETAIL_CACHE_ENTRIES = 48
const tmdbResponseCache = new Map<string, CacheEntry<unknown>>()
const tmdbRequestCache = new Map<string, Promise<unknown>>()
const movieDetailCache = new Map<number, CacheEntry<MovieDetailBundle>>()
const movieDetailRequestCache = new Map<number, Promise<MovieDetailBundle>>()

const GENRES: Genre[] = [
  { id: 28, name: 'Action' },
  { id: 35, name: 'Comedy' },
  { id: 18, name: 'Drama' },
  { id: 27, name: 'Horror' },
  { id: 9648, name: 'Mystery' },
  { id: 10749, name: 'Romance' },
  { id: 878, name: 'Sci-Fi' },
  { id: 53, name: 'Thriller' },
  { id: 16, name: 'Animation' },
  { id: 10751, name: 'Family' },
]

const MOODS: {
  key: MoodKey
  label: string
  description: string
  genres: number[]
  sortBy: string
}[] = [
  {
    key: 'feel-good',
    label: 'Feel-good',
    description: 'light, warm, and easy to recommend for a relaxed evening',
    genres: [35, 10751],
    sortBy: 'popularity.desc',
  },
  {
    key: 'intense',
    label: 'Intense',
    description: 'high energy stories with suspense, action, and stakes',
    genres: [28, 53],
    sortBy: 'popularity.desc',
  },
  {
    key: 'mind-bending',
    label: 'Mind-bending',
    description: 'clever plots, twists, and speculative worlds',
    genres: [878, 9648],
    sortBy: 'vote_average.desc',
  },
  {
    key: 'heartfelt',
    label: 'Heartfelt',
    description: 'emotion-first picks with romance and drama at the center',
    genres: [18, 10749],
    sortBy: 'vote_average.desc',
  },
]

const ERAS: {
  key: EraKey
  label: string
  releaseDateGte?: string
  releaseDateLte?: string
}[] = [
  { key: 'any', label: 'Any era' },
  { key: 'recent', label: '2020s', releaseDateGte: '2020-01-01' },
  {
    key: '2010s',
    label: '2010s',
    releaseDateGte: '2010-01-01',
    releaseDateLte: '2019-12-31',
  },
  {
    key: '2000s',
    label: '2000s',
    releaseDateGte: '2000-01-01',
    releaseDateLte: '2009-12-31',
  },
  { key: 'classics', label: 'Before 2000', releaseDateLte: '1999-12-31' },
]

function createDefaultAppState(): PersistedAppState {
  return {
    mode: 'compass',
    view: 'recommendations',
    selectedGenres: [878, 9648],
    selectedMood: 'mind-bending',
    selectedEra: 'recent',
    seedQuery: '',
    selectedSeedMovie: null,
    selectedMovie: null,
    watchlistOverlayOpen: false,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function getNullableString(value: unknown) {
  return typeof value === 'string' ? value : null
}

function getNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function getTimestampNumber(value: unknown, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value)

    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return fallback
}

function getStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function isMoodKey(value: unknown): value is MoodKey {
  return MOODS.some((mood) => mood.key === value)
}

function isEraKey(value: unknown): value is EraKey {
  return ERAS.some((era) => era.key === value)
}

function normalizeMovieRecord(value: unknown): Movie | null {
  if (!isRecord(value)) {
    return null
  }

  const rawId = value.id
  const id =
    typeof rawId === 'number' && Number.isFinite(rawId)
      ? rawId
      : typeof rawId === 'string'
        ? Number(rawId)
        : NaN

  if (!Number.isFinite(id) || typeof value.title !== 'string') {
    return null
  }

  return {
    id,
    title: value.title,
    overview: getString(value.overview),
    poster_path: getNullableString(value.poster_path),
    backdrop_path: getNullableString(value.backdrop_path),
    release_date: getString(value.release_date),
    vote_average: getNumber(value.vote_average),
    genre_ids: Array.isArray(value.genre_ids)
      ? value.genre_ids.filter((genreId): genreId is number => typeof genreId === 'number')
      : [],
  }
}

function normalizeMovie(movie: Movie) {
  return {
    id: movie.id,
    title: movie.title,
    overview: movie.overview,
    poster_path: movie.poster_path,
    backdrop_path: movie.backdrop_path,
    release_date: movie.release_date,
    vote_average: movie.vote_average,
    genre_ids: movie.genre_ids ?? [],
  }
}

function normalizeSearchMovie(value: unknown): SearchMovie | null {
  if (!isRecord(value)) {
    return null
  }

  const rawId = value.id
  const id =
    typeof rawId === 'number' && Number.isFinite(rawId)
      ? rawId
      : typeof rawId === 'string'
        ? Number(rawId)
        : NaN

  if (!Number.isFinite(id) || typeof value.title !== 'string') {
    return null
  }

  return {
    id,
    title: value.title,
    release_date: getString(value.release_date),
  }
}

function normalizePersistedAppState(value: PersistedAppState | null) {
  const defaults = createDefaultAppState()

  if (!value || !isRecord(value)) {
    return defaults
  }

  return {
    mode: value.mode === 'seed' ? 'seed' : defaults.mode,
    view: value.view === 'catalog' ? 'catalog' : defaults.view,
    selectedGenres: Array.isArray(value.selectedGenres)
      ? value.selectedGenres.filter((genreId): genreId is number => typeof genreId === 'number')
      : defaults.selectedGenres,
    selectedMood: isMoodKey(value.selectedMood) ? value.selectedMood : defaults.selectedMood,
    selectedEra: isEraKey(value.selectedEra) ? value.selectedEra : defaults.selectedEra,
    seedQuery: typeof value.seedQuery === 'string' ? value.seedQuery : defaults.seedQuery,
    selectedSeedMovie: normalizeSearchMovie(value.selectedSeedMovie),
    selectedMovie: normalizeMovieRecord(value.selectedMovie),
    watchlistOverlayOpen:
      typeof value.watchlistOverlayOpen === 'boolean'
        ? value.watchlistOverlayOpen
        : defaults.watchlistOverlayOpen,
  }
}

function normalizeCommentRecord(commentId: string, value: unknown): MovieComment | null {
  if (!isRecord(value)) {
    return null
  }

  const userId = getString(value.userId)
  const userName = getString(value.userName)
  const text = getString(value.text)

  if (!userId || !userName || !text) {
    return null
  }

  return {
    id: commentId,
    userId,
    userName,
    text,
    createdAtMs: getTimestampNumber(value.createdAtMs ?? value.createdAt, Date.now()),
    likes: getStringArray(value.likes),
    replies: [],
  }
}

function normalizeReplyRecord(replyId: string, value: unknown): MovieReply | null {
  if (!isRecord(value)) {
    return null
  }

  const commentId = getString(value.commentId)
  const userId = getString(value.userId)
  const userName = getString(value.userName)
  const text = getString(value.text)

  if (!commentId || !userId || !userName || !text) {
    return null
  }

  return {
    id: replyId,
    commentId,
    userId,
    userName,
    text,
    createdAtMs: getTimestampNumber(value.createdAtMs ?? value.createdAt, Date.now()),
  }
}

function normalizeRatingRecord(ratingId: string, value: unknown): MovieRating | null {
  if (!isRecord(value)) {
    return null
  }

  const userId = getString(value.userId, ratingId)
  const userName = getString(value.userName)
  const numericValue = getNumber(value.value)

  if (!userId || !userName || numericValue < 1 || numericValue > 5) {
    return null
  }

  return {
    userId,
    userName,
    value: numericValue,
    updatedAtMs: getTimestampNumber(value.updatedAtMs ?? value.createdAt, Date.now()),
  }
}

function buildDiscussion(
  comments: MovieComment[],
  replies: MovieReply[],
  ratings: MovieRating[],
): MovieDiscussion {
  const repliesByComment = new Map<string, MovieReply[]>()

  replies.forEach((reply) => {
    const currentReplies = repliesByComment.get(reply.commentId) ?? []
    repliesByComment.set(
      reply.commentId,
      [...currentReplies, reply].sort((left, right) => left.createdAtMs - right.createdAtMs),
    )
  })

  return {
    comments: comments.map((comment) => ({
      ...comment,
      replies: repliesByComment.get(comment.id) ?? [],
    })),
    ratings: [...ratings].sort((left, right) => right.updatedAtMs - left.updatedAtMs),
  }
}

function buildLegacyDiscussion(value: unknown): MovieDiscussion {
  if (!isRecord(value)) {
    return { comments: [], ratings: [] }
  }

  const comments = Array.isArray(value.comments)
    ? value.comments
        .flatMap((legacyComment) => {
          if (!isRecord(legacyComment)) {
            return []
          }

          const commentId =
            typeof legacyComment.id === 'string' && legacyComment.id
              ? legacyComment.id
              : createId()
          const normalizedComment = normalizeCommentRecord(commentId, legacyComment)

          if (!normalizedComment) {
            return []
          }

          const replies = Array.isArray(legacyComment.replies)
            ? legacyComment.replies
                .map((legacyReply) => {
                  if (!isRecord(legacyReply)) {
                    return null
                  }

                  const replyId =
                    typeof legacyReply.id === 'string' && legacyReply.id
                      ? legacyReply.id
                      : createId()

                  return normalizeReplyRecord(replyId, {
                    ...legacyReply,
                    commentId,
                  })
                })
                .filter((reply): reply is MovieReply => reply !== null)
            : []

          return [
            {
              ...normalizedComment,
              replies,
            },
          ]
        })
        .sort((left, right) => left.createdAtMs - right.createdAtMs)
    : []

  const ratings = Array.isArray(value.ratings)
    ? value.ratings
        .map((legacyRating) => {
          if (!isRecord(legacyRating)) {
            return null
          }

          return normalizeRatingRecord(getString(legacyRating.userId), legacyRating)
        })
        .filter((rating): rating is MovieRating => rating !== null)
    : []

  return { comments, ratings }
}

function mergeDiscussion(
  legacyDiscussion: MovieDiscussion,
  subcollectionDiscussion: MovieDiscussion,
): MovieDiscussion {
  const commentMap = new Map<string, MovieComment>()
  const ratingMap = new Map<string, MovieRating>()

  legacyDiscussion.comments.forEach((comment) => {
    commentMap.set(comment.id, comment)
  })

  subcollectionDiscussion.comments.forEach((comment) => {
    commentMap.set(comment.id, comment)
  })

  legacyDiscussion.ratings.forEach((rating) => {
    ratingMap.set(rating.userId, rating)
  })

  subcollectionDiscussion.ratings.forEach((rating) => {
    ratingMap.set(rating.userId, rating)
  })

  return {
    comments: Array.from(commentMap.values()).sort(
      (left, right) => left.createdAtMs - right.createdAtMs,
    ),
    ratings: Array.from(ratingMap.values()).sort(
      (left, right) => right.updatedAtMs - left.updatedAtMs,
    ),
  }
}

function mergeUniqueMovies(currentMovies: Movie[], nextMovies: Movie[]) {
  const movieMap = new Map<number, Movie>()

  currentMovies.forEach((movie) => {
    movieMap.set(movie.id, movie)
  })

  nextMovies.forEach((movie) => {
    movieMap.set(movie.id, movie)
  })

  return Array.from(movieMap.values())
}

function getYear(date?: string) {
  return date ? date.slice(0, 4) : 'TBA'
}

function getPoster(movie: Movie) {
  if (movie.poster_path) return `${IMAGE_BASE}${movie.poster_path}`
  if (movie.backdrop_path) return `https://image.tmdb.org/t/p/w780${movie.backdrop_path}`
  return FALLBACK_POSTER
}

function getPosterSrcSet(movie: Movie) {
  if (!movie.poster_path) {
    return undefined
  }

  return [
    `https://image.tmdb.org/t/p/w342${movie.poster_path} 342w`,
    `https://image.tmdb.org/t/p/w500${movie.poster_path} 500w`,
    `https://image.tmdb.org/t/p/w780${movie.poster_path} 780w`,
  ].join(', ')
}

function getRuntimeLabel(runtime: number | null) {
  if (!runtime) {
    return 'Runtime unavailable'
  }

  const hours = Math.floor(runtime / 60)
  const minutes = runtime % 60

  if (!hours) {
    return `${minutes}m`
  }

  return `${hours}h ${minutes}m`
}

function formatProviders(providers?: Provider[]) {
  if (!providers?.length) {
    return 'Not listed'
  }

  return providers.map((provider) => provider.provider_name).join(', ')
}

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function toggleGenre(current: number[], genreId: number) {
  return current.includes(genreId)
    ? current.filter((id) => id !== genreId)
    : [...current, genreId]
}

async function fetchTmdb<T>(
  path: string,
  params: Record<string, string> = {},
  options: TmdbFetchOptions = {},
) {
  const searchParams = new URLSearchParams({
    language: 'en-US',
    include_adult: 'false',
    ...params,
  })

  const cacheKey = `${path}?${searchParams.toString()}`
  const cachedValue = getCachedValue(tmdbResponseCache, cacheKey)

  if (cachedValue) {
    return cachedValue as T
  }

  const existingRequest = tmdbRequestCache.get(cacheKey)

  if (existingRequest) {
    return (await existingRequest) as T
  }

  const request = (async () => {
    const response = USE_DIRECT_TMDB
      ? await fetch(
          `${DIRECT_API_BASE}${path}?${new URLSearchParams({
            api_key: API_KEY,
            ...Object.fromEntries(searchParams),
          }).toString()}`,
          { signal: options.signal },
        )
      : await fetch(
          `/api/tmdb?${new URLSearchParams({
            path,
            ...Object.fromEntries(searchParams),
          }).toString()}`,
          { signal: options.signal },
        )

    if (!response.ok) {
      throw new Error('TMDB request failed. Please check TMDB credentials and network access.')
    }

    const data = (await response.json()) as T
    setCachedValue(
      tmdbResponseCache,
      cacheKey,
      data,
      TMDB_CACHE_TTL_MS,
      MAX_TMDB_CACHE_ENTRIES,
    )
    return data
  })()

  tmdbRequestCache.set(cacheKey, request)

  try {
    return await request
  } finally {
    tmdbRequestCache.delete(cacheKey)
  }
}

async function fetchMovieDetailBundle(movieId: number) {
  const cachedBundle = getCachedValue(movieDetailCache, movieId)

  if (cachedBundle) {
    return cachedBundle
  }

  const existingRequest = movieDetailRequestCache.get(movieId)

  if (existingRequest) {
    return await existingRequest
  }

  const request = (async () => {
    const [details, providers, credits, similar] = await Promise.all([
      fetchTmdb<MovieDetails>(`/movie/${movieId}`),
      fetchTmdb<WatchProvidersResponse>(`/movie/${movieId}/watch/providers`),
      fetchTmdb<{ cast: CastMember[] }>(`/movie/${movieId}/credits`),
      fetchTmdb<{ results: Movie[] }>(`/movie/${movieId}/similar`),
    ])

    const bundle = {
      details,
      providers: providers.results?.US ?? null,
      cast: credits.cast.slice(0, 8),
      related: similar.results.slice(0, 6),
    }

    setCachedValue(
      movieDetailCache,
      movieId,
      bundle,
      DETAIL_CACHE_TTL_MS,
      MAX_DETAIL_CACHE_ENTRIES,
    )
    return bundle
  })()

  movieDetailRequestCache.set(movieId, request)

  try {
    return await request
  } finally {
    movieDetailRequestCache.delete(movieId)
  }
}

function App() {
  const defaultAppState = createDefaultAppState()
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null)
  const [watchlist, setWatchlist] = useState<Movie[]>([])
  const [authLoading, setAuthLoading] = useState(true)
  const [appStateReady, setAppStateReady] = useState(false)
  const [mode, setMode] = useState<'compass' | 'seed'>(defaultAppState.mode)
  const [view, setView] = useState<'recommendations' | 'catalog'>(defaultAppState.view)
  const [selectedGenres, setSelectedGenres] = useState<number[]>(defaultAppState.selectedGenres)
  const [selectedMood, setSelectedMood] = useState<MoodKey>(defaultAppState.selectedMood)
  const [selectedEra, setSelectedEra] = useState<EraKey>(defaultAppState.selectedEra)
  const [discoverMovies, setDiscoverMovies] = useState<Movie[]>([])
  const [catalogMovies, setCatalogMovies] = useState<Movie[]>([])
  const [catalogPage, setCatalogPage] = useState(0)
  const [heroMovie, setHeroMovie] = useState<Movie | null>(null)
  const [seedQuery, setSeedQuery] = useState(defaultAppState.seedQuery)
  const [searchResults, setSearchResults] = useState<SearchMovie[]>([])
  const [selectedSeedMovie, setSelectedSeedMovie] = useState<SearchMovie | null>(
    defaultAppState.selectedSeedMovie,
  )
  const [seedRecommendations, setSeedRecommendations] = useState<Movie[]>([])
  const [discoverLoading, setDiscoverLoading] = useState(false)
  const [seedLoading, setSeedLoading] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(defaultAppState.selectedMovie)
  const [spotlightMovie, setSpotlightMovie] = useState<Movie | null>(null)
  const [movieDetails, setMovieDetails] = useState<MovieDetails | null>(null)
  const [movieCast, setMovieCast] = useState<CastMember[]>([])
  const [movieProviders, setMovieProviders] = useState<WatchProviderRegion | null>(null)
  const [relatedMovies, setRelatedMovies] = useState<Movie[]>([])
  const [movieDiscussion, setMovieDiscussion] = useState<MovieDiscussion>({
    comments: [],
    ratings: [],
  })
  const [detailLoading, setDetailLoading] = useState(false)
  const [profileDraft, setProfileDraft] = useState('')
  const [profileSaving, setProfileSaving] = useState(false)
  const [watchlistUpdatingId, setWatchlistUpdatingId] = useState<number | null>(null)
  const [watchlistOverlayOpen, setWatchlistOverlayOpen] = useState(
    defaultAppState.watchlistOverlayOpen,
  )
  const [commentDraft, setCommentDraft] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [openReplyId, setOpenReplyId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const deferredQuery = useDeferredValue(seedQuery)
  const sliderRef = useRef<HTMLDivElement | null>(null)
  const migratedUsersRef = useRef(new Set<string>())

  function applyPersistedState(state: PersistedAppState) {
    setMode(state.mode)
    setView(state.view)
    setSelectedGenres(state.selectedGenres)
    setSelectedMood(state.selectedMood)
    setSelectedEra(state.selectedEra)
    setSeedQuery(state.seedQuery)
    setSelectedSeedMovie(state.selectedSeedMovie)
    setSelectedMovie(state.selectedMovie)
    setWatchlistOverlayOpen(state.watchlistOverlayOpen)
  }

  async function migrateLegacyWatchlist(userId: string, legacyWatchlist: unknown[]) {
    if (!db || migratedUsersRef.current.has(userId)) {
      return
    }

    const firestore = db
    migratedUsersRef.current.add(userId)

    try {
      const moviesToMigrate = legacyWatchlist
        .map((movie) => normalizeMovieRecord(movie))
        .filter((movie): movie is Movie => movie !== null)

      if (moviesToMigrate.length === 0) {
        return
      }

      await Promise.all(
        moviesToMigrate.map((movie, index) =>
          setDoc(
            doc(firestore, 'users', userId, 'watchlist', String(movie.id)),
            {
              ...normalizeMovie(movie),
              addedAt: serverTimestamp(),
              addedAtMs: Date.now() - index,
            },
            { merge: true },
          ),
        ),
      )
    } catch (error) {
      migratedUsersRef.current.delete(userId)
      throw error
    }
  }

  useEffect(() => {
    if (!firebaseEnabled || !auth || !db) {
      setAuthLoading(false)
      setAppStateReady(true)
      return
    }

    const firebaseAuth = auth
    const firestore = db
    let cancelled = false
    let unsubscribeProfile = () => {}
    let unsubscribeWatchlist = () => {}

    const resetTransientState = () => {
      setDiscoverMovies([])
      setCatalogMovies([])
      setCatalogPage(0)
      setSeedRecommendations([])
      setHeroMovie(null)
      setMovieDetails(null)
      setMovieCast([])
      setMovieProviders(null)
      setRelatedMovies([])
      setSearchResults([])
      setWatchlist([])
      setMovieDiscussion({ comments: [], ratings: [] })
      setCommentDraft('')
      setReplyDrafts({})
      setOpenReplyId(null)
    }

    let unsubscribeAuth = () => {}

    void authReady.finally(() => {
      if (cancelled) {
        return
      }

      unsubscribeAuth = onAuthStateChanged(firebaseAuth, (firebaseUser) => {
        unsubscribeProfile()
        unsubscribeWatchlist()

        if (!firebaseUser) {
          setCurrentUser(null)
          setProfileDraft('')
          setAuthLoading(false)
          setAppStateReady(false)
          resetTransientState()
          applyPersistedState(createDefaultAppState())
          return
        }

        const persistedState = normalizePersistedAppState(
          readStoredAppState<PersistedAppState>(firebaseUser.uid),
        )

        applyPersistedState(persistedState)
        resetTransientState()
        setCurrentUser({
          uid: firebaseUser.uid,
          displayName: firebaseUser.displayName || 'MovieSphere User',
          email: firebaseUser.email || '',
          bio: '',
        })
        setProfileDraft('')
        setAuthLoading(false)
        setAppStateReady(true)

        if (persistedState.view === 'catalog') {
          void loadCatalogPage(1, true)
        }

        unsubscribeProfile = onSnapshot(doc(firestore, 'users', firebaseUser.uid), (snapshot) => {
          const profileData = snapshot.data()

          if (Array.isArray(profileData?.watchlist) && profileData.watchlist.length > 0) {
            void migrateLegacyWatchlist(firebaseUser.uid, profileData.watchlist).catch(
              () => undefined,
            )
          }

          setCurrentUser((current) => ({
            uid: firebaseUser.uid,
            displayName: getString(
              profileData?.displayName,
              current?.displayName || firebaseUser.displayName || 'MovieSphere User',
            ),
            email: getString(profileData?.email, current?.email || firebaseUser.email || ''),
            bio: getString(profileData?.bio),
          }))
          setProfileDraft(getString(profileData?.bio))
        })

        unsubscribeWatchlist = onSnapshot(
          query(
            collection(firestore, 'users', firebaseUser.uid, 'watchlist'),
            orderBy('addedAtMs', 'desc'),
          ),
          (snapshot) => {
            const nextWatchlist = snapshot.docs
              .map((watchlistDoc) =>
                normalizeMovieRecord({
                  id: watchlistDoc.id,
                  ...watchlistDoc.data(),
                }),
              )
              .filter((movie): movie is Movie => movie !== null)

            setWatchlist(nextWatchlist)
          },
        )
      })
    })

    return () => {
      cancelled = true
      unsubscribeProfile()
      unsubscribeWatchlist()
      unsubscribeAuth()
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !currentUser || !appStateReady) {
      return
    }

    const stateToPersist: PersistedAppState = {
      mode,
      view,
      selectedGenres,
      selectedMood,
      selectedEra,
      seedQuery,
      selectedSeedMovie,
      selectedMovie: selectedMovie ? normalizeMovie(selectedMovie) : null,
      watchlistOverlayOpen,
    }

    writeStoredAppState(currentUser.uid, stateToPersist)
  }, [
    appStateReady,
    currentUser,
    mode,
    view,
    selectedGenres,
    selectedMood,
    selectedEra,
    seedQuery,
    selectedSeedMovie,
    selectedMovie,
    watchlistOverlayOpen,
  ])

  useEffect(() => {
    if (!currentUser || !appStateReady) {
      return
    }

    let cancelled = false

    async function loadDiscoverMovies() {
      setDiscoverLoading(true)
      setErrorMessage('')

      const mood = MOODS.find(({ key }) => key === selectedMood)
      const era = ERAS.find(({ key }) => key === selectedEra)
      const withGenres = Array.from(new Set([...selectedGenres, ...(mood?.genres ?? [])])).join(',')

      try {
        const data = await fetchTmdb<{ results: Movie[] }>('/discover/movie', {
          sort_by: mood?.sortBy ?? 'popularity.desc',
          vote_count_gte: '180',
          with_genres: withGenres,
          ...(era?.releaseDateGte ? { 'release_date.gte': era.releaseDateGte } : {}),
          ...(era?.releaseDateLte ? { 'release_date.lte': era.releaseDateLte } : {}),
        })

        if (!cancelled) {
          setDiscoverMovies(data.results.slice(0, 12))
          setHeroMovie(data.results[0] ?? null)
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error ? error.message : 'Unable to load movies right now.',
          )
        }
      } finally {
        if (!cancelled) {
          setDiscoverLoading(false)
        }
      }
    }

    void loadDiscoverMovies()

    return () => {
      cancelled = true
    }
  }, [appStateReady, currentUser, selectedEra, selectedGenres, selectedMood])

  useEffect(() => {
    if (!currentUser || !appStateReady) {
      return
    }

    if (deferredQuery.trim().length < 2) {
      setSearchResults([])
      return
    }

    const controller = new AbortController()

    async function searchMovies() {
      try {
        const data = await fetchTmdb<{ results: SearchMovie[] }>(
          '/search/movie',
          {
            query: deferredQuery.trim(),
            page: '1',
          },
          { signal: controller.signal },
        )

        if (!controller.signal.aborted) {
          startTransition(() => {
            setSearchResults(data.results.slice(0, 5))
          })
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return
        }

        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setSearchResults([])
        }
      }
    }

    void searchMovies()

    return () => {
      controller.abort()
    }
  }, [appStateReady, currentUser, deferredQuery])

  useEffect(() => {
    if (!currentUser || !appStateReady) {
      return
    }

    if (!selectedSeedMovie) {
      setSeedRecommendations([])
      return
    }

    const seedMovieId = selectedSeedMovie.id
    let cancelled = false

    async function loadRecommendations() {
      setSeedLoading(true)
      setErrorMessage('')

      try {
        const data = await fetchTmdb<{ results: Movie[] }>(`/movie/${seedMovieId}/recommendations`)

        if (!cancelled) {
          setSeedRecommendations(data.results.slice(0, 12))
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error ? error.message : 'Unable to load recommendations.',
          )
        }
      } finally {
        if (!cancelled) {
          setSeedLoading(false)
        }
      }
    }

    void loadRecommendations()

    return () => {
      cancelled = true
    }
  }, [appStateReady, currentUser, selectedSeedMovie])

  useEffect(() => {
    if (!selectedMovie) {
      setMovieDetails(null)
      setMovieCast([])
      setMovieProviders(null)
      setRelatedMovies([])
      setMovieDiscussion({ comments: [], ratings: [] })
      setCommentDraft('')
      setReplyDrafts({})
      setOpenReplyId(null)
      return
    }

    const selectedMovieId = selectedMovie.id
    let cancelled = false

    async function loadMovieDetails() {
      const cachedBundle = getCachedValue(movieDetailCache, selectedMovieId)

      if (cachedBundle) {
        setMovieDetails(cachedBundle.details)
        setMovieProviders(cachedBundle.providers)
        setMovieCast(cachedBundle.cast)
        setRelatedMovies(cachedBundle.related)
        setDetailLoading(false)
        return
      }

      setDetailLoading(true)

      try {
        const bundle = await fetchMovieDetailBundle(selectedMovieId)

        if (!cancelled) {
          setMovieDetails(bundle.details)
          setMovieProviders(bundle.providers)
          setMovieCast(bundle.cast)
          setRelatedMovies(bundle.related)
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error ? error.message : 'Unable to load movie details.',
          )
        }
      } finally {
        if (!cancelled) {
          setDetailLoading(false)
        }
      }
    }

    void loadMovieDetails()

    return () => {
      cancelled = true
    }
  }, [selectedMovie])

  useEffect(() => {
    if (!selectedMovie || !db) {
      setMovieDiscussion({ comments: [], ratings: [] })
      return
    }

    let legacyDiscussionState: MovieDiscussion = { comments: [], ratings: [] }
    let commentsState: MovieComment[] = []
    let repliesState: MovieReply[] = []
    let ratingsState: MovieRating[] = []

    const syncDiscussion = () => {
      const modernDiscussion = buildDiscussion(commentsState, repliesState, ratingsState)
      setMovieDiscussion(mergeDiscussion(legacyDiscussionState, modernDiscussion))
    }

    const unsubscribeLegacy = onSnapshot(
      doc(db, 'movieDiscussions', String(selectedMovie.id)),
      (snapshot) => {
        legacyDiscussionState = buildLegacyDiscussion(snapshot.data())
        syncDiscussion()
      },
    )

    const unsubscribeComments = onSnapshot(
      query(collection(db, 'movieDiscussions', String(selectedMovie.id), 'comments'), orderBy('createdAtMs', 'asc')),
      (snapshot) => {
        commentsState = snapshot.docs
          .map((commentDoc) => normalizeCommentRecord(commentDoc.id, commentDoc.data()))
          .filter((comment): comment is MovieComment => comment !== null)
        syncDiscussion()
      },
    )

    const unsubscribeReplies = onSnapshot(
      query(collection(db, 'movieDiscussions', String(selectedMovie.id), 'replies'), orderBy('createdAtMs', 'asc')),
      (snapshot) => {
        repliesState = snapshot.docs
          .map((replyDoc) => normalizeReplyRecord(replyDoc.id, replyDoc.data()))
          .filter((reply): reply is MovieReply => reply !== null)
        syncDiscussion()
      },
    )

    const unsubscribeRatings = onSnapshot(
      query(collection(db, 'movieDiscussions', String(selectedMovie.id), 'ratings'), orderBy('updatedAtMs', 'desc')),
      (snapshot) => {
        ratingsState = snapshot.docs
          .map((ratingDoc) => normalizeRatingRecord(ratingDoc.id, ratingDoc.data()))
          .filter((rating): rating is MovieRating => rating !== null)
        syncDiscussion()
      },
    )

    return () => {
      unsubscribeLegacy()
      unsubscribeComments()
      unsubscribeReplies()
      unsubscribeRatings()
    }
  }, [selectedMovie])

  async function loadCatalogPage(page: number, replace = false) {
    setCatalogLoading(true)
    setErrorMessage('')

    try {
      const data = await fetchTmdb<{ page: number; total_pages: number; results: Movie[] }>(
        '/discover/movie',
        {
          sort_by: 'popularity.desc',
          vote_count_gte: '200',
          page: String(page),
        },
      )

      setCatalogPage(data.page)
      setCatalogMovies((current) =>
        replace ? data.results : mergeUniqueMovies(current, data.results),
      )
      setHeroMovie((current) => current ?? data.results[0] ?? null)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Unable to load the TMDB catalog.',
      )
    } finally {
      setCatalogLoading(false)
    }
  }

  const activeMood = MOODS.find(({ key }) => key === selectedMood)
  const recommendationMovies = mode === 'compass' ? discoverMovies : seedRecommendations
  const recommendationLoading = mode === 'compass' ? discoverLoading : seedLoading
  const activeMovies = view === 'catalog' ? catalogMovies : recommendationMovies
  const activeLoading = view === 'catalog' ? catalogLoading : recommendationLoading
  const seedMovieTitle = selectedSeedMovie?.title ?? ''
  const detailMovie = movieDetails ?? selectedMovie
  const detailGenres = movieDetails?.genres.map((genre) => genre.name).join(', ') ?? ''
  const spotlightGenres = GENRES.filter((genre) => selectedGenres.includes(genre.id)).map(
    (genre) => genre.name,
  )
  const activeEraLabel = ERAS.find((era) => era.key === selectedEra)?.label ?? 'Any era'
  const displayMovie = heroMovie ?? activeMovies[0] ?? null
  const userRating =
    movieDiscussion.ratings.find((rating) => rating.userId === currentUser?.uid)?.value ?? 0
  const averageUserRating = movieDiscussion.ratings.length
    ? movieDiscussion.ratings.reduce((sum, rating) => sum + rating.value, 0) /
      movieDiscussion.ratings.length
    : 0
  const statusText = errorMessage
    ? errorMessage
    : activeLoading
      ? view === 'catalog'
        ? 'Loading the latest catalog drops...'
        : 'Cooking up movie recommendations...'
      : ''

  useEffect(() => {
    if (!activeMovies.length) {
      return
    }

    if (!heroMovie || !activeMovies.some((movie) => movie.id === heroMovie.id)) {
      setHeroMovie(activeMovies[0])
    }
  }, [activeMovies, heroMovie])

  useEffect(() => {
    if (activeMovies.length === 0) {
      setSpotlightMovie(heroMovie)
      return
    }

    const bestRatedMovie = [...activeMovies].sort(
      (left, right) => right.vote_average - left.vote_average,
    )[0]

    setSpotlightMovie(bestRatedMovie ?? activeMovies[0])
  }, [activeMovies, heroMovie])

  useEffect(() => {
    const moviesToPrefetch = activeMovies.slice(0, 4)

    moviesToPrefetch.forEach((movie) => {
      void fetchMovieDetailBundle(movie.id).catch(() => undefined)
    })
  }, [activeMovies])

  async function toggleWatchlist(movie: Movie) {
    if (!currentUser || !db) {
      return
    }

    const normalizedMovie = normalizeMovie(movie)
    const previousWatchlist = watchlist
    const inWatchlist = previousWatchlist.some((item) => item.id === movie.id)
    const nextWatchlist = inWatchlist
      ? previousWatchlist.filter((item) => item.id !== movie.id)
      : [normalizedMovie, ...previousWatchlist.filter((item) => item.id !== movie.id)]

    setWatchlistUpdatingId(movie.id)
    setErrorMessage('')
    setWatchlist(nextWatchlist)

    try {
      const watchlistRef = doc(db, 'users', currentUser.uid, 'watchlist', String(movie.id))

      if (inWatchlist) {
        await deleteDoc(watchlistRef)
      } else {
        await setDoc(watchlistRef, {
          ...normalizedMovie,
          addedAt: serverTimestamp(),
          addedAtMs: Date.now(),
        })
      }
    } catch (error) {
      setWatchlist(previousWatchlist)
      setErrorMessage(
        error instanceof Error ? error.message : 'Unable to update the watchlist right now.',
      )
    } finally {
      setWatchlistUpdatingId(null)
    }
  }

  async function submitComment() {
    if (!currentUser || !db || !selectedMovie || !commentDraft.trim()) {
      return
    }

    setErrorMessage('')

    try {
      await setDoc(doc(db, 'movieDiscussions', String(selectedMovie.id), 'comments', createId()), {
        userId: currentUser.uid,
        userName: currentUser.displayName,
        text: commentDraft.trim(),
        likes: [],
        createdAt: serverTimestamp(),
        createdAtMs: Date.now(),
      })
      setCommentDraft('')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to post this comment.')
    }
  }

  async function toggleCommentLike(commentId: string) {
    if (!currentUser || !db || !selectedMovie) {
      return
    }

    const comment = movieDiscussion.comments.find((item) => item.id === commentId)

    if (!comment) {
      return
    }

    setErrorMessage('')

    try {
      await updateDoc(doc(db, 'movieDiscussions', String(selectedMovie.id), 'comments', commentId), {
        likes: comment.likes.includes(currentUser.uid)
          ? arrayRemove(currentUser.uid)
          : arrayUnion(currentUser.uid),
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now(),
      })
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Unable to update the like right now.',
      )
    }
  }

  async function submitReply(commentId: string) {
    if (!currentUser || !db || !selectedMovie) {
      return
    }

    const draft = replyDrafts[commentId]?.trim()

    if (!draft) {
      return
    }

    setErrorMessage('')

    try {
      await setDoc(doc(db, 'movieDiscussions', String(selectedMovie.id), 'replies', createId()), {
        commentId,
        userId: currentUser.uid,
        userName: currentUser.displayName,
        text: draft,
        createdAt: serverTimestamp(),
        createdAtMs: Date.now(),
      })
      setReplyDrafts((current) => ({ ...current, [commentId]: '' }))
      setOpenReplyId(null)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to post this reply.')
    }
  }

  async function submitRating(value: number) {
    if (!currentUser || !db || !selectedMovie) {
      return
    }

    setErrorMessage('')

    try {
      await setDoc(
        doc(db, 'movieDiscussions', String(selectedMovie.id), 'ratings', currentUser.uid),
        {
          userId: currentUser.uid,
          userName: currentUser.displayName,
          value,
          updatedAt: serverTimestamp(),
          updatedAtMs: Date.now(),
        },
        { merge: true },
      )
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to save your rating.')
    }
  }

  async function saveProfile() {
    if (!currentUser || !db) {
      return
    }

    const user = currentUser
    const nextBio = profileDraft.trim()

    setProfileSaving(true)
    setErrorMessage('')
    setCurrentUser({
      ...user,
      bio: nextBio,
    })

    try {
      await setDoc(
        doc(db, 'users', user.uid),
        {
          uid: user.uid,
          displayName: user.displayName,
          email: user.email,
          bio: nextBio,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      )
    } catch (error) {
      setCurrentUser(user)
      setErrorMessage(error instanceof Error ? error.message : 'Unable to save your profile.')
    } finally {
      setProfileSaving(false)
    }
  }

  function scrollSlider(direction: number) {
    sliderRef.current?.scrollBy({
      left: direction * 320,
      behavior: 'smooth',
    })
  }

  function prefetchMovieDetails(movie: Movie) {
    void fetchMovieDetailBundle(movie.id).catch(() => undefined)
  }

  function openMovieDetails(movie: Movie) {
    setSelectedMovie(normalizeMovie(movie))
    void fetchMovieDetailBundle(movie.id).catch(() => undefined)
  }

  async function handleLogout() {
    if (!auth || !currentUser) {
      return
    }

    const firebaseAuth = auth
    clearStoredAppState(currentUser.uid)
    setSelectedMovie(null)
    setWatchlistOverlayOpen(false)

    try {
      await signOut(firebaseAuth)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to log out right now.')
    }
  }

  if (authLoading) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <p>Loading MovieSphere...</p>
        </section>
      </main>
    )
  }

  if (!currentUser) {
    return (
      <Suspense
        fallback={
          <main className="auth-shell">
            <section className="auth-panel">
              <p>Loading sign in...</p>
            </section>
          </main>
        }
      >
        <AuthPage onAuthSuccess={() => undefined} />
      </Suspense>
    )
  }

  const user = currentUser

  return (
    <main className="app-shell">
      <div className="ticker">
        <div className="ticker-inner">
          <span className="ticker-word pink">MOVIESPHERE</span>
          <span className="ticker-word yellow">FINDS</span>
          <span className="ticker-word cream">YOUR NEXT WATCH</span>
          <span className="ticker-word pink">BY MOOD</span>
          <span className="ticker-word yellow">BY TASTE</span>
          <span className="ticker-word cream">BY CATALOG</span>
          <span className="ticker-sep">✦</span>
          <span className="ticker-word yellow">MOVIESPHERE</span>
          <span className="ticker-word pink">CURATES</span>
          <span className="ticker-word cream">THE NIGHT</span>
          <span className="ticker-word yellow">POPULAR PICKS</span>
          <span className="ticker-word pink">HIDDEN GEMS</span>
          <span className="ticker-word cream">ONE TAP AWAY</span>
          <span className="ticker-sep">✦</span>
        </div>
      </div>

      <nav className="yard-nav">
        <a className="nav-logo" href="#home">
          MovieSphere
        </a>
        <ul className="nav-links">
          <li>
            <a href="#lineup">Lineup</a>
          </li>
          <li>
            <a href="#discover">Discover</a>
          </li>
          <li>
            <button
              className="cart-link"
              onClick={() => {
                setView('catalog')

                if (catalogMovies.length === 0) {
                  void loadCatalogPage(1, true)
                }
              }}
              type="button"
            >
              All movies
            </button>
          </li>
          <li>
            <button className="ghost-link" onClick={() => void handleLogout()} type="button">
              Logout
            </button>
          </li>
        </ul>
      </nav>

      <section className="hero" id="home">
        <div className="hero-blob"></div>
        <div className="hero-blob2"></div>

        <div className="hero-text">
          <div className="hero-eyebrow">
            <div className="dot"></div>
            <span>{`Welcome back • ${user.displayName}`}</span>
          </div>

          <h1 className="hero-h1">
            <span className="pink">YOUR</span>
            <br />
            <span>NEXT</span>
            <br />
            <span className="yellow">MOVIE</span>
          </h1>

          <p className="hero-sub">
            MovieSphere turns a huge catalog into something cinematic, playful, and easy to
            explore. Start with a mood, a favorite film, or dive into the full movie catalog.
          </p>

          <div className="hero-pills">
            {MOODS.map((mood) => (
              <button
                className={selectedMood === mood.key ? 'hero-pill active' : 'hero-pill'}
                key={mood.key}
                onClick={() => {
                  setView('recommendations')
                  setMode('compass')
                  setSelectedMood(mood.key)
                }}
                type="button"
              >
                {mood.label}
              </button>
            ))}
          </div>

          <div className="hero-btns">
            <a className="btn-hero-primary" href="#lineup">
              Browse picks ↓
            </a>
            <a className="btn-hero-secondary" href="#discover">
              Adjust filters
            </a>
          </div>

          <div className="hero-mini-stats">
            <div className="hms-chip">
              <div>
                <div className="hms-val">{mode === 'compass' ? '2' : '1'}</div>
                <div className="hms-lbl">
                  {mode === 'compass' ? 'Discovery modes' : 'Seed mode'}
                </div>
              </div>
            </div>
            <div className="hms-chip">
              <div>
                <div className="hms-val">{activeEraLabel}</div>
                <div className="hms-lbl">Current era</div>
              </div>
            </div>
            <div className="hms-chip">
              <div>
                <div className="hms-val">{activeMovies.length || 0}</div>
                <div className="hms-lbl">Cards in view</div>
              </div>
            </div>
          </div>
        </div>

        <div className="hero-img-wrap">
          <div className="hero-img-ring">
            <img
              alt={displayMovie ? `${displayMovie.title} poster` : 'Movie poster'}
              decoding="async"
              id="heroShakeImg"
              loading="eager"
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = FALLBACK_POSTER }}
              sizes="(max-width: 900px) 320px, 500px"
              src={
                displayMovie
                  ? getPoster(displayMovie)
                  : FALLBACK_POSTER
              }
              srcSet={displayMovie ? getPosterSrcSet(displayMovie) : undefined}
            />
          </div>
          <div className="hero-badge">
            {view === 'catalog' ? 'All movies' : activeMood?.label ?? 'Movie vibe'}
          </div>
        </div>
      </section>

      <div className="stats-strip">
        <div className="stat">
          <div className="stat-num">{spotlightGenres.length || 3}</div>
          <div className="stat-label">Genre signals</div>
        </div>
        <div className="stat">
          <div className="stat-num">{activeMovies.length}</div>
          <div className="stat-label">Visible cards</div>
        </div>
        <div className="stat">
          <div className="stat-num">{watchlist.length}</div>
          <div className="stat-label">Watchlist saves</div>
        </div>
      </div>

      <section className="discover-console" id="discover">
        <div className="section-header">
          <h2>
            TUNE THE
            <br />
            <em>DISCOVERY</em>
          </h2>
          <p>
            Shift between guided recommendations and the broader movie catalog without losing the
            same bold MovieSphere feel.
          </p>
        </div>

        {statusText ? (
          <p className={`status-banner ${errorMessage ? 'error' : ''}`}>{statusText}</p>
        ) : null}

        <div className="discover-grid">
          <div className="discover-card">
            <div className="mode-switch" role="tablist" aria-label="Recommendation mode">
              <button
                className={mode === 'compass' ? 'active' : ''}
                onClick={() => {
                  setView('recommendations')
                  setMode('compass')
                }}
                type="button"
              >
                Preference compass
              </button>
              <button
                className={mode === 'seed' ? 'active' : ''}
                onClick={() => {
                  setView('recommendations')
                  setMode('seed')
                }}
                type="button"
              >
                Start from a movie
              </button>
            </div>

            {mode === 'compass' ? (
              <>
                <label className="panel-label">Genres</label>
                <div className="chip-grid">
                  {GENRES.map((genre) => (
                    <button
                      className={selectedGenres.includes(genre.id) ? 'chip active' : 'chip'}
                      key={genre.id}
                      onClick={() =>
                        setSelectedGenres((current) => toggleGenre(current, genre.id))
                      }
                      type="button"
                    >
                      {genre.name}
                    </button>
                  ))}
                </div>

                <label className="panel-label">Era</label>
                <div className="pill-row">
                  {ERAS.map((era) => (
                    <button
                      className={selectedEra === era.key ? 'pill active' : 'pill'}
                      key={era.key}
                      onClick={() => setSelectedEra(era.key)}
                      type="button"
                    >
                      {era.label}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <label className="panel-label" htmlFor="seed-search">
                  Search a favorite movie
                </label>
                <input
                  className="search-input"
                  id="seed-search"
                  onChange={(event) => setSeedQuery(event.target.value)}
                  placeholder="Try Interstellar, Dune, La La Land..."
                  type="text"
                  value={seedQuery}
                />

                {searchResults.length > 0 ? (
                  <div className="search-results">
                    {searchResults.map((movie) => (
                      <button
                        className={
                          selectedSeedMovie?.id === movie.id
                            ? 'search-result active'
                            : 'search-result'
                        }
                        key={movie.id}
                        onClick={() => {
                          setSelectedSeedMovie(movie)
                          setSeedQuery(movie.title)
                          setSearchResults([])
                        }}
                        type="button"
                      >
                        <span>{movie.title}</span>
                        <small>{getYear(movie.release_date)}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div className="discover-card spotlight-card">
            <p className="eyebrow">Spotlight</p>
            <h3>{spotlightMovie?.title ?? 'Movie spotlight loading'}</h3>
            <div className="spotlight-meta">
              <span>{spotlightMovie ? getYear(spotlightMovie.release_date) : 'Year'}</span>
              <span>
                {spotlightMovie ? `${spotlightMovie.vote_average.toFixed(1)} / 10` : 'Rating'}
              </span>
              <span>{view === 'catalog' ? 'Catalog mode' : activeMood?.label ?? 'Movie vibe'}</span>
            </div>
            <p>
              {spotlightMovie?.overview ??
                'The best rated movie from the current selection appears here to anchor the page.'}
            </p>
          </div>
        </div>
      </section>

      <section className="slider-section" id="lineup">
        <div className="section-header">
          <h2>
            THE
            <br />
            <em>LINEUP</em>
          </h2>
          <p>
            {view === 'catalog'
              ? 'Browse a wider stream of popular titles from TMDB and open any card for the full movie breakdown.'
              : mode === 'seed'
                ? seedMovieTitle
                  ? `Because you picked ${seedMovieTitle}, here is a sharper lineup of related titles.`
                  : 'Start from one movie you already trust, then let MovieSphere build the next row for you.'
                : 'These cards are tuned by mood, genres, and era so you can compare strong options quickly.'}
          </p>
        </div>

        <div className="slider-viewport">
          <div className="slider-track" ref={sliderRef}>
            {activeMovies.map((movie, index) => (
              <button
                className={`shake-card ${index % 5 === 0 ? 'card-strawberry' : index % 5 === 1 ? 'card-coconut' : index % 5 === 2 ? 'card-blueberry' : index % 5 === 3 ? 'card-banana' : 'card-grapefruit'}`}
                key={movie.id}
                onClick={() => openMovieDetails(movie)}
                onFocus={() => prefetchMovieDetails(movie)}
                onMouseEnter={() => prefetchMovieDetails(movie)}
                type="button"
              >
                <span className="card-chip">
                  {view === 'catalog' ? 'Catalog' : activeMood?.label ?? 'Pick'}
                </span>
                <img
                  alt={`${movie.title} poster`}
                  className="card-img"
                  decoding="async"
                  loading="lazy"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).src = FALLBACK_POSTER }}
                  sizes="220px"
                  src={getPoster(movie)}
                  srcSet={getPosterSrcSet(movie)}
                />
                <div className="card-bottom">
                  <div className="card-name">{movie.title}</div>
                  <div className="card-desc">
                    {movie.overview || 'No plot summary is available for this movie yet.'}
                  </div>
                  <div className="card-footer">
                    <div className="card-price">{movie.vote_average.toFixed(1)} ★</div>
                    <span className="card-btn">OPEN +</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="slider-controls">
          <button className="ctrl-btn" onClick={() => scrollSlider(-1)} type="button">
            ←
          </button>
          <button className="ctrl-btn" onClick={() => scrollSlider(1)} type="button">
            →
          </button>
          {view === 'catalog' ? (
            <button
              className="catalog-button inline"
              disabled={catalogLoading}
              onClick={() => void loadCatalogPage((catalogPage || 0) + 1, false)}
              type="button"
            >
              {catalogLoading ? 'Loading...' : 'Load more'}
            </button>
          ) : null}
        </div>
      </section>

      <section className="newsletter">
        <div className="newsletter-inner">
          <div className="nl-left">
            <div className="nl-tag">🎬 Join the sphere</div>
            <h2>
              SAVE YOUR
              <br />
              TASTE.
              <br />
              BROWSE.
            </h2>
            <div className="nl-proof">
              <div className="nl-avatars">
                <div className="nl-avatar av1">M</div>
                <div className="nl-avatar av2">S</div>
                <div className="nl-avatar av3">P</div>
                <div className="nl-avatar av4">R</div>
              </div>
              <div className="nl-proof-text">
                <strong>{user.displayName}</strong>
                is already exploring with MovieSphere
              </div>
            </div>
          </div>
          <div className="nl-right">
            <div className="nl-perks">
              <div className="nl-perk">
                <div className="nl-perk-icon">🔥</div>
                <span>Jump between recommendations and the movie catalog instantly</span>
              </div>
              <div className="nl-perk">
                <div className="nl-perk-icon">📺</div>
                <span>Open movie details and streaming availability in one tap</span>
              </div>
              <div className="nl-perk">
                <div className="nl-perk-icon">🧠</div>
                <span>Use mood, era, and taste instead of endless scrolling</span>
              </div>
            </div>
            <div className="nl-form">
              <input
                className="nl-input"
                readOnly
                type="text"
                value={`Logged in as ${user.displayName}`}
              />
              <button
                className="nl-btn"
                onClick={() => {
                  setView('catalog')

                  if (catalogMovies.length === 0) {
                    void loadCatalogPage(1, true)
                  }
                }}
                type="button"
              >
                OPEN CATALOG ↗
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="lifestyle">
        <div className="lifestyle-inner">
          <div className="lifestyle-img-wrap">
            <div className="lifestyle-img-frame">
              <img
                alt={spotlightMovie ? `${spotlightMovie.title} poster` : 'MovieSphere pick'}
                decoding="async"
                loading="lazy"
                onError={(e) => { (e.currentTarget as HTMLImageElement).src = FALLBACK_POSTER }}
                sizes="(max-width: 900px) 320px, 420px"
                src={
                  spotlightMovie
                    ? getPoster(spotlightMovie)
                    : FALLBACK_POSTER
                }
                srcSet={spotlightMovie ? getPosterSrcSet(spotlightMovie) : undefined}
              />
            </div>
            <div className="ls-badge">
              {spotlightMovie ? getYear(spotlightMovie.release_date) : 'Featured'}
            </div>
          </div>
          <div className="lifestyle-content">
            <div className="ls-kicker">movie night guide</div>
            <h2 className="ls-title">
              REFINE.
              <br />
              COMPARE.
              <br />
              WATCH.
            </h2>
            <p className="ls-copy">
              {spotlightMovie?.overview ??
                'Use the spotlight card to anchor your choice, then open the detail view whenever you want cast, runtime, and streaming availability.'}
            </p>
            <ul className="ls-features">
              <li>
                <div className="ls-dot"></div>
                <strong>Current mode</strong> —{' '}
                {view === 'catalog'
                  ? 'All movies catalog'
                  : mode === 'compass'
                    ? 'Preference compass'
                    : 'Seed recommendation'}
              </li>
              <li>
                <div className="ls-dot"></div>
                <strong>Era focus</strong> — {activeEraLabel}
              </li>
              <li>
                <div className="ls-dot"></div>
                <strong>Genre signal</strong> —{' '}
                {spotlightGenres.slice(0, 3).join(', ') || 'Open selection'}
              </li>
            </ul>
            <div className="ls-btns">
              <a className="ls-btn-s" href="#discover">
                Adjust filters
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="ingredients-section">
        <div className="section-header">
          <h2>
            YOUR
            <br />
            <em>PROFILE</em>
          </h2>
          <p>
            Your account, bio, and watchlist stay close to the movie night guide for a cleaner
            flow.
          </p>
        </div>

        <div className="ingredients-grid">
          <div className="ing-card c1">
            <div className="ing-num">01 —</div>
            <div className="ing-name">Profile</div>
            <div className="ing-desc">{user.displayName}</div>
            <div className="ing-desc">{user.email}</div>
          </div>
          <div className="ing-card c2">
            <div className="ing-num">02 —</div>
            <div className="ing-name">Bio</div>
            <textarea
              className="search-input profile-bio"
              onChange={(event) => setProfileDraft(event.target.value)}
              placeholder="Tell MovieSphere what kind of movies you love..."
              value={profileDraft}
            />
            <button className="catalog-button" onClick={() => void saveProfile()} type="button">
              {profileSaving ? 'Saving...' : 'Save profile'}
            </button>
          </div>
          <div className="ing-card c3">
            <div className="ing-num">03 —</div>
            <div className="ing-name">Watchlist</div>
            <div className="ing-desc">{watchlist.length} saved movies</div>
            <div className="watchlist-mini">
              {watchlist.slice(0, 4).map((movie) => (
                <button
                  key={movie.id}
                  onClick={() => openMovieDetails(movie)}
                  onFocus={() => prefetchMovieDetails(movie)}
                  onMouseEnter={() => prefetchMovieDetails(movie)}
                  type="button"
                >
                  {movie.title}
                </button>
              ))}
              {watchlist.length === 0 ? <span>No saved movies yet.</span> : null}
            </div>
            {watchlist.length > 0 ? (
              <button
                className="catalog-button watchlist-toggle"
                onClick={() => setWatchlistOverlayOpen(true)}
                type="button"
              >
                My watchlist
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <footer>
        <div className="footer-inner">
          <div className="footer-logo-wrap">
            <a className="footer-logo-text" href="#home">
              MovieSphere
            </a>
            <span className="footer-dev-label">Recommendation interface</span>
            <p className="footer-disclaimer">
              This product uses the TMDB API but is not endorsed or certified by TMDB.
            </p>
          </div>

          <div className="footer-links">
            <a href="#discover">Discover</a>
            <a href="#lineup">Lineup</a>
            <a href="#home">Back to top</a>
          </div>

          <div className="footer-contact">
            <button
              className="footer-contact-btn btn-codepen"
              onClick={() => {
                setView('recommendations')
                setMode('seed')
              }}
              type="button"
            >
              Seed mode
            </button>
            <button
              className="footer-contact-btn btn-email"
              onClick={() => {
                setView('catalog')

                if (catalogMovies.length === 0) {
                  void loadCatalogPage(1, true)
                }
              }}
              type="button"
            >
              All movies
            </button>
          </div>
        </div>
      </footer>

      {selectedMovie ? (
        <section className="detail-overlay" role="dialog" aria-modal="true" aria-label="Movie details">
          <button
            aria-label="Close movie details"
            className="detail-backdrop"
            onClick={() => setSelectedMovie(null)}
            type="button"
          />

          <div className="detail-panel">
            <div className="detail-header">
              <p className="eyebrow">Movie catalog</p>
              <button className="detail-close" onClick={() => setSelectedMovie(null)} type="button">
                Close
              </button>
            </div>

            {detailMovie ? (
              <div className="detail-layout">
                <div className="detail-poster-wrap">
                  <img
                    alt={`${detailMovie.title} poster`}
                    className="detail-poster"
                    decoding="async"
                    loading="eager"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).src = FALLBACK_POSTER }}
                    sizes="(max-width: 900px) 320px, 420px"
                    src={getPoster(detailMovie)}
                    srcSet={getPosterSrcSet(detailMovie)}
                  />
                </div>

                <div className="detail-content">
                  <div className="detail-hero">
                    <h2>{detailMovie.title}</h2>
                    <p className="detail-tagline">
                      {movieDetails?.tagline || 'Expanded movie information and streaming details'}
                    </p>
                    <div className="spotlight-meta">
                      <span>{getYear(detailMovie.release_date)}</span>
                      <span>{detailMovie.vote_average.toFixed(1)} / 10</span>
                      <span>{getRuntimeLabel(movieDetails?.runtime ?? null)}</span>
                      <span>{movieDetails?.status ?? 'Loading details'}</span>
                    </div>
                    <p>{detailMovie.overview}</p>
                    <div className="catalog-actions">
                      <button
                        className="catalog-button"
                        disabled={watchlistUpdatingId === detailMovie.id}
                        onClick={() => void toggleWatchlist(detailMovie)}
                        type="button"
                      >
                        {watchlistUpdatingId === detailMovie.id
                          ? 'Updating...'
                          : watchlist.some((movie) => movie.id === detailMovie.id)
                            ? 'Remove from watchlist'
                            : 'Add to watchlist'}
                      </button>
                      {detailLoading ? (
                        <span className="provider-note">Loading extended details...</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="detail-grid">
                    <section className="detail-card">
                      <h3>About this movie</h3>
                      <div className="summary-list">
                        <div>
                          <span>Genres</span>
                          <strong>{detailGenres || 'Not available'}</strong>
                        </div>
                        <div>
                          <span>Release year</span>
                          <strong>{getYear(detailMovie.release_date)}</strong>
                        </div>
                        <div>
                          <span>Runtime</span>
                          <strong>{getRuntimeLabel(movieDetails?.runtime ?? null)}</strong>
                        </div>
                      </div>
                    </section>

                    <section className="detail-card">
                      <h3>Where to watch</h3>
                      <div className="provider-list">
                        <div>
                          <span>Stream</span>
                          <strong>{formatProviders(movieProviders?.flatrate)}</strong>
                        </div>
                        <div>
                          <span>Rent</span>
                          <strong>{formatProviders(movieProviders?.rent)}</strong>
                        </div>
                        <div>
                          <span>Buy</span>
                          <strong>{formatProviders(movieProviders?.buy)}</strong>
                        </div>
                      </div>
                      <p className="provider-note">Availability shown for the United States.</p>
                      {movieProviders?.link ? (
                        <a
                          className="provider-link"
                          href={movieProviders.link}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open streaming links
                        </a>
                      ) : null}
                    </section>

                    <section className="detail-card">
                      <h3>Community rating</h3>
                      <div className="rating-summary">
                        <strong>
                          {averageUserRating ? averageUserRating.toFixed(1) : 'No rating yet'}
                        </strong>
                        <span>
                          {movieDiscussion.ratings.length} user
                          {movieDiscussion.ratings.length === 1 ? '' : 's'} rated this movie
                        </span>
                      </div>
                      <div className="rating-stars">
                        {[1, 2, 3, 4, 5].map((value) => (
                          <button
                            className={value <= userRating ? 'rating-star active' : 'rating-star'}
                            key={value}
                            onClick={() => void submitRating(value)}
                            type="button"
                          >
                            ★
                          </button>
                        ))}
                      </div>
                    </section>

                    <section className="detail-card">
                      <h3>Main cast</h3>
                      <div className="cast-list">
                        {movieCast.length > 0 ? (
                          movieCast.map((person) => (
                            <div className="cast-item" key={person.id}>
                              <strong>{person.name}</strong>
                              <span>{person.character || 'Cast'}</span>
                            </div>
                          ))
                        ) : (
                          <p>No cast details available.</p>
                        )}
                      </div>
                    </section>

                    <section className="detail-card">
                      <h3>Related movies</h3>
                      <div className="related-grid">
                        {relatedMovies.length > 0 ? (
                          relatedMovies.map((movie) => (
                            <button
                              className="related-card"
                              key={movie.id}
                              onClick={() => openMovieDetails(movie)}
                              onFocus={() => prefetchMovieDetails(movie)}
                              onMouseEnter={() => prefetchMovieDetails(movie)}
                              type="button"
                            >
                              <img
                                alt={`${movie.title} poster`}
                                decoding="async"
                                loading="lazy"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).src = FALLBACK_POSTER }}
                                sizes="180px"
                                src={getPoster(movie)}
                                srcSet={getPosterSrcSet(movie)}
                              />
                              <span>{movie.title}</span>
                            </button>
                          ))
                        ) : (
                          <p>No related movies available.</p>
                        )}
                      </div>
                    </section>

                    <section className="detail-card discussion-card">
                      <h3>Discussion</h3>
                      <div className="discussion-form">
                        <textarea
                          className="search-input profile-bio"
                          onChange={(event) => setCommentDraft(event.target.value)}
                          placeholder="Share your thoughts about this movie..."
                          value={commentDraft}
                        />
                        <button
                          className="catalog-button"
                          onClick={() => void submitComment()}
                          type="button"
                        >
                          Post comment
                        </button>
                      </div>

                      <div className="comment-list">
                        {movieDiscussion.comments.length > 0 ? (
                          movieDiscussion.comments
                            .slice()
                            .reverse()
                            .map((comment) => (
                              <article className="comment-item" key={comment.id}>
                                <div className="comment-head">
                                  <strong>{comment.userName}</strong>
                                  <span>{new Date(comment.createdAtMs).toLocaleDateString()}</span>
                                </div>
                                <p>{comment.text}</p>
                                <div className="comment-actions">
                                  <button
                                    className="comment-action"
                                    onClick={() => void toggleCommentLike(comment.id)}
                                    type="button"
                                  >
                                    {comment.likes.includes(currentUser.uid) ? 'Unlike' : 'Like'} (
                                    {comment.likes.length})
                                  </button>
                                  <button
                                    className="comment-action"
                                    onClick={() =>
                                      setOpenReplyId((current) =>
                                        current === comment.id ? null : comment.id,
                                      )
                                    }
                                    type="button"
                                  >
                                    Reply ({comment.replies.length})
                                  </button>
                                </div>

                                {comment.replies.length > 0 ? (
                                  <div className="reply-list">
                                    {comment.replies.map((reply) => (
                                      <div className="reply-item" key={reply.id}>
                                        <strong>{reply.userName}</strong>
                                        <span>{reply.text}</span>
                                      </div>
                                    ))}
                                  </div>
                                ) : null}

                                {openReplyId === comment.id ? (
                                  <div className="reply-form">
                                    <input
                                      className="search-input"
                                      onChange={(event) =>
                                        setReplyDrafts((current) => ({
                                          ...current,
                                          [comment.id]: event.target.value,
                                        }))
                                      }
                                      placeholder="Write a reply..."
                                      type="text"
                                      value={replyDrafts[comment.id] ?? ''}
                                    />
                                    <button
                                      className="catalog-button secondary-action"
                                      onClick={() => void submitReply(comment.id)}
                                      type="button"
                                    >
                                      Reply
                                    </button>
                                  </div>
                                ) : null}
                              </article>
                            ))
                        ) : (
                          <p>No comments yet. Be the first to start the conversation.</p>
                        )}
                      </div>
                    </section>
                  </div>
                </div>
              </div>
            ) : (
              <p className="status-banner">Loading movie details...</p>
            )}
          </div>
        </section>
      ) : null}

      {watchlistOverlayOpen ? (
        <section className="detail-overlay" role="dialog" aria-modal="true" aria-label="My watchlist">
          <button
            aria-label="Close watchlist"
            className="detail-backdrop"
            onClick={() => setWatchlistOverlayOpen(false)}
            type="button"
          />

          <div className="detail-panel watchlist-overlay-panel">
            <div className="detail-header">
              <div>
                <p className="eyebrow">My watchlist</p>
                <h2>{watchlist.length} saved movies</h2>
              </div>
              <button
                className="detail-close"
                onClick={() => setWatchlistOverlayOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="watchlist-expanded-head">
              <p>All movies you have added to your watchlist are shown here.</p>
            </div>

            <div className="watchlist-grid">
              {watchlist.map((movie) => (
                <button
                  className="related-card watchlist-card"
                  key={movie.id}
                  onClick={() => {
                    setWatchlistOverlayOpen(false)
                    openMovieDetails(movie)
                  }}
                  onFocus={() => prefetchMovieDetails(movie)}
                  onMouseEnter={() => prefetchMovieDetails(movie)}
                  type="button"
                >
                  <img
                    alt={`${movie.title} poster`}
                    decoding="async"
                    loading="lazy"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).src = FALLBACK_POSTER }}
                    sizes="220px"
                    src={getPoster(movie)}
                    srcSet={getPosterSrcSet(movie)}
                  />
                  <span>{movie.title}</span>
                </button>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </main>
  )
}

export default App
