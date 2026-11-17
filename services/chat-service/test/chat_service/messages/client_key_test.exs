defmodule ChatService.Messages.ClientKeyTest do
  @moduledoc """
  The dedupe rules of a keyed send (ChatService.Messages.ClientKey), with the
  key store and the insert replaced by doubles: no Cassandra, Kafka or PubSub.
  """
  use ExUnit.Case, async: true

  alias ChatService.Messages.ClientKey
  alias ChatService.Messages.ClientKeyStore.Cassandra
  alias ChatService.Messages.Message

  @conv "22222222-2222-2222-2222-222222222222"
  @sender "153"
  @key "temp-1794002400000-123456"
  @new_id "aaaaaaaa-c0a8-11f1-8000-000000000001"
  @old_id "bbbbbbbb-c0a8-11f1-8000-000000000002"

  defp message(id) do
    %Message{
      conversation_id: @conv,
      message_id: id,
      sender_id: @sender,
      content: "I sent this message when we didn't have service",
      content_type: "text"
    }
  end

  # Store doubles: each reports its calls to the test process.
  defmodule Claims do
    def claim(conv, sender, key, id) do
      send(self(), {:claim, conv, sender, key, id})
      :claimed
    end

    def release(conv, sender, key), do: send(self(), {:release, conv, sender, key}) && :ok
    def fetch_message(_conv, _id), do: flunk_fetch()
    defp flunk_fetch, do: raise("fetch_message must not be called")
  end

  defmodule Taken do
    def claim(_conv, _sender, _key, _id), do: {:taken, "bbbbbbbb-c0a8-11f1-8000-000000000002"}
    def release(_conv, _sender, _key), do: raise("release must not be called")

    def fetch_message(conv, id) do
      send(self(), {:fetch, conv, id})

      {:ok,
       %Message{
         conversation_id: conv,
         message_id: id,
         sender_id: "153",
         content: "first copy",
         content_type: "text"
       }}
    end
  end

  defmodule TakenStillWriting do
    def claim(_conv, _sender, _key, _id), do: {:taken, "bbbbbbbb-c0a8-11f1-8000-000000000002"}
    def release(_conv, _sender, _key), do: :ok

    def fetch_message(_conv, _id) do
      send(self(), :fetch)
      {:error, :not_found}
    end
  end

  defmodule Down do
    def claim(_conv, _sender, _key, _id), do: {:error, :timeout}
    def release(_conv, _sender, _key), do: raise("release must not be called")
    def fetch_message(_conv, _id), do: raise("fetch_message must not be called")
  end

  defp insert_ok do
    fn ->
      send(self(), :inserted)
      {:ok, message(@new_id)}
    end
  end

  describe "from_opts/1" do
    test "reads the key the app sends in the metadata" do
      assert ClientKey.from_opts(metadata: %{"clientKey" => @key, "effect" => nil}) == @key
    end

    test "an explicit key wins over the metadata" do
      assert ClientKey.from_opts(client_key: "temp-a", metadata: %{"clientKey" => "temp-b"}) ==
               "temp-a"
    end

    test "older apps send no key: nothing to dedupe" do
      assert ClientKey.from_opts([]) == nil
      assert ClientKey.from_opts(metadata: nil) == nil
      assert ClientKey.from_opts(metadata: %{"effect" => %{"kind" => "bubble"}}) == nil
    end

    test "a malformed key is ignored instead of blocking the message" do
      assert ClientKey.from_opts(metadata: %{"clientKey" => ""}) == nil
      assert ClientKey.from_opts(metadata: %{"clientKey" => 42}) == nil
      assert ClientKey.from_opts(metadata: %{"clientKey" => "has space"}) == nil
      assert ClientKey.from_opts(metadata: %{"clientKey" => String.duplicate("a", 129)}) == nil
      assert ClientKey.from_opts(client_key: "bad'key", metadata: %{"clientKey" => @key}) == @key
    end
  end

  describe "dedupe/6" do
    test "no key: the message is stored as always, the store is not asked" do
      assert {:ok, %Message{message_id: @new_id}} =
               ClientKey.dedupe(@conv, @sender, nil, @new_id, insert_ok(), store: Down)

      assert_received :inserted
    end

    test "first send with a key claims it and stores the message" do
      assert {:ok, %Message{message_id: @new_id}} =
               ClientKey.dedupe(@conv, @sender, @key, @new_id, insert_ok(), store: Claims)

      assert_received {:claim, @conv, @sender, @key, @new_id}
      assert_received :inserted
      refute_received {:release, _, _, _}
    end

    test "the same key again returns the first message and stores nothing" do
      assert {:ok, %Message{message_id: @old_id, content: "first copy"}} =
               ClientKey.dedupe(@conv, @sender, @key, @new_id, insert_ok(), store: Taken)

      assert_received {:fetch, @conv, @old_id}
      refute_received :inserted
    end

    test "a failed insert frees the key so the next try can store it" do
      failing = fn -> {:error, :insert_failed} end

      assert {:error, :insert_failed} =
               ClientKey.dedupe(@conv, @sender, @key, @new_id, failing, store: Claims)

      assert_received {:release, @conv, @sender, @key}
    end

    test "two copies at once: the second waits for the first, then gives a retryable error" do
      assert {:error, :duplicate_in_flight} =
               ClientKey.dedupe(@conv, @sender, @key, @new_id, insert_ok(),
                 store: TakenStillWriting,
                 tries: 3,
                 wait_ms: 0
               )

      assert_received :fetch
      assert_received :fetch
      assert_received :fetch
      refute_received :fetch
      refute_received :inserted
    end

    test "store down: the message still goes, without dedupe" do
      assert {:ok, %Message{message_id: @new_id}} =
               ClientKey.dedupe(@conv, @sender, @key, @new_id, insert_ok(), store: Down)

      assert_received :inserted
    end
  end

  describe "Cassandra answers" do
    test "a conditional insert that applied claims the key" do
      assert Cassandra.claim_outcome(%{"[applied]" => true}) == :claimed
    end

    test "one that did not apply names the message already there" do
      assert Cassandra.claim_outcome(%{"[applied]" => false, "message_id" => @old_id}) ==
               {:taken, @old_id}
    end

    test "anything else is an error, so the send goes through undeduped" do
      assert {:error, _} = Cassandra.claim_outcome(%{"[applied]" => false})
      assert {:error, _} = Cassandra.claim_outcome(nil)
    end

    test "a missing table is recognised, other errors are not" do
      assert Cassandra.missing_table?(%{message: "unconfigured table message_client_keys"})
      assert Cassandra.missing_table?("table atto_chat.message_client_keys does not exist")
      refute Cassandra.missing_table?(:timeout)
      refute Cassandra.missing_table?("message_client_keys write timeout")
    end

    test "the table is additive: its own name, a TTL, keyed by conversation and sender" do
      ddl = ChatService.Messages.ClientKeyStore.table_ddl("atto_chat")
      assert ddl =~ "CREATE TABLE IF NOT EXISTS atto_chat.message_client_keys"
      assert ddl =~ "PRIMARY KEY ((conversation_id, sender_id), client_key)"
      assert ddl =~ "default_time_to_live"
    end
  end
end
