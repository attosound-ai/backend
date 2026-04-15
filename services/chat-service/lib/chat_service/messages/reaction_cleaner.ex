defmodule ChatService.Messages.ReactionCleaner do
  @moduledoc """
  Cascade contract for cleaning up collateral state when a message is
  soft-deleted.

  Today the only collateral is reactions attached to the message, so the
  default implementation delegates to
  `ChatService.Reactions.ReactionService.delete_all_for_message/2`. Future
  cascades (mention indexes, unread counters, push-notification recall)
  can be added as new implementations without touching `MessageService` —
  Open/Closed Principle.
  """

  @callback cleanup(message_id :: String.t(), conversation_id :: String.t()) :: :ok

  @spec cleanup(String.t(), String.t()) :: :ok
  def cleanup(message_id, conversation_id) do
    impl().cleanup(message_id, conversation_id)
  end

  defp impl do
    Application.get_env(
      :chat_service,
      :message_reaction_cleaner,
      ChatService.Messages.ReactionCleaner.Default
    )
  end
end

defmodule ChatService.Messages.ReactionCleaner.Default do
  @moduledoc """
  Default cascade: deletes every reaction row for the message via
  `ReactionService`. Errors are already swallowed-and-logged at the
  `ReactionService` level, so this impl always returns `:ok` — a deleted
  message must never leave the pipeline in an ambiguous state.
  """

  @behaviour ChatService.Messages.ReactionCleaner

  @impl true
  def cleanup(message_id, conversation_id) do
    ChatService.Reactions.ReactionService.delete_all_for_message(message_id, conversation_id)
  end
end
