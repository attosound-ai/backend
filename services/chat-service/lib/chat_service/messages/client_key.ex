defmodule ChatService.Messages.ClientKey do
  @moduledoc """
  A message sent twice is stored once.

  The app keeps a text it could not deliver in an outbox and sends it again
  when the connection comes back (Nov 2026: the client wrote without service
  and asked whether it would send by itself). When a first try reached this
  service but its answer was lost (a socket push that timed out, a request
  that died on a weak radio), the retry used to create a second message.

  Each send may carry a client key: the `temp-…` id the app gave the row,
  sent as `metadata.clientKey` (every build since the outbox) or as a
  top level `client_key` / `clientKey`. The first send with a key claims it
  for that sender in that conversation; a later send with the same key gets
  the message the first one created, and nothing is stored, broadcast or
  published again.

  Additive and optional: a send without a key (every older app) goes through
  exactly as before. If the key store cannot be reached, the send also goes
  through as before (fail open): losing the dedupe is better than losing the
  message.

  The claim is a lightweight transaction (`INSERT … IF NOT EXISTS`) in the
  `message_client_keys` table, so two copies arriving at the same instant
  still produce one message. See `ChatService.Messages.ClientKeyStore`.
  """

  require Logger

  @max_length 128
  @pattern ~r/\A[A-Za-z0-9_.:\-]+\z/

  @doc """
  The client key of a send, from its options: `:client_key`, or the
  `clientKey` inside `:metadata`. Anything that is not a short plain string
  is ignored, so a malformed key never blocks a message.
  """
  @spec from_opts(keyword()) :: String.t() | nil
  def from_opts(opts) when is_list(opts) do
    explicit = Keyword.get(opts, :client_key)

    from_metadata =
      case Keyword.get(opts, :metadata) do
        %{"clientKey" => key} -> key
        %{clientKey: key} -> key
        _ -> nil
      end

    valid(explicit) || valid(from_metadata)
  end

  @doc "A key worth using: a non empty plain string of at most 128 characters."
  @spec valid(term()) :: String.t() | nil
  def valid(key) when is_binary(key) do
    if byte_size(key) in 1..@max_length and Regex.match?(@pattern, key), do: key, else: nil
  end

  def valid(_), do: nil

  @doc """
  Runs `insert` (which stores and announces a new message with `message_id`)
  at most once per `{conversation_id, sender_id, key}`.

  Returns what `insert` returns, or `{:ok, existing_message}` when the key
  was already used. With no key it simply calls `insert`.

  Options (for tests): `:store` (the `ClientKeyStore` implementation),
  `:wait_ms` and `:tries` for the short wait when the first copy claimed the
  key but has not finished writing its message yet.
  """
  @spec dedupe(String.t(), String.t(), String.t() | nil, String.t(), (-> term()), keyword()) ::
          term()
  def dedupe(conversation_id, sender_id, key, message_id, insert, opts \\ [])

  def dedupe(_conversation_id, _sender_id, nil, _message_id, insert, _opts), do: insert.()

  def dedupe(conversation_id, sender_id, key, message_id, insert, opts) do
    store = Keyword.get(opts, :store, ChatService.Messages.ClientKeyStore.impl())

    case store.claim(conversation_id, sender_id, key, message_id) do
      :claimed ->
        case insert.() do
          {:ok, _} = ok ->
            ok

          other ->
            # Nothing was stored: free the key so the next try can store it.
            store.release(conversation_id, sender_id, key)
            other
        end

      {:taken, existing_id} ->
        Logger.info(
          "[CLIENT_KEY] duplicate send conv=#{conversation_id} sender=#{sender_id} " <>
            "key=#{key} existing=#{existing_id}"
        )

        existing(store, conversation_id, existing_id, opts)

      {:error, reason} ->
        Logger.warning(
          "[CLIENT_KEY] store unavailable, sending without dedupe: #{inspect(reason)}"
        )

        insert.()
    end
  end

  # The first copy claims the key before it writes the message, so for a few
  # milliseconds the key can point at a message that is not there yet.
  defp existing(store, conversation_id, message_id, opts) do
    tries = Keyword.get(opts, :tries, 5)
    wait_ms = Keyword.get(opts, :wait_ms, 100)
    fetch_existing(store, conversation_id, message_id, tries, wait_ms)
  end

  defp fetch_existing(_store, _conversation_id, _message_id, 0, _wait_ms),
    do: {:error, :duplicate_in_flight}

  defp fetch_existing(store, conversation_id, message_id, tries, wait_ms) do
    case store.fetch_message(conversation_id, message_id) do
      {:ok, message} ->
        {:ok, message}

      {:error, :not_found} ->
        if wait_ms > 0, do: Process.sleep(wait_ms)
        fetch_existing(store, conversation_id, message_id, tries - 1, wait_ms)

      {:error, reason} ->
        Logger.error("[CLIENT_KEY] could not read the first copy: #{inspect(reason)}")
        {:error, :query_failed}
    end
  end
end
