defmodule ChatServiceWeb.TokenExpiry do
  @moduledoc """
  A WebSocket lives only as long as the token it connected with (Nov 12 2026).

  The socket verified the JWT once, at connect, and then stayed open for
  hours: a token stolen and used once kept receiving every message, even
  after a password reset closed every session of the account. Now each
  channel arms a timer for the token's `exp` (plus a small leeway) and, when
  it fires, the whole socket is disconnected. The app already handles that
  close: it sees its token expired, refreshes it and reconnects with the
  fresh one (src/lib/api/phoenixSocket.ts). A closed session cannot refresh,
  so it stays out. A rejoin on a socket whose token already expired is
  refused the same way.
  """

  import Phoenix.Socket, only: [assign: 3]

  # Clock skew between user-service and this service, and room for the app's
  # own early refresh (60 s before exp) to win the race.
  @leeway_s 60

  @doc "Unique id for this socket; `user_socket:<user>:<ref>`."
  def socket_id(user_id, ref), do: "user_socket:#{user_id}:#{ref}"

  @doc "Assigns used by the channels; `exp` may be nil (no expiry claim)."
  def assign_token(socket, exp) do
    socket
    |> assign(:token_exp, exp)
    |> assign(:socket_ref, Integer.to_string(System.unique_integer([:positive])))
  end

  @doc "True when the token behind this socket is past exp plus the leeway."
  def expired?(socket, now_s \\ System.system_time(:second)) do
    case socket.assigns[:token_exp] do
      exp when is_integer(exp) -> now_s > exp + @leeway_s
      _ -> false
    end
  end

  @doc "Milliseconds until the socket must close, or nil when there is no exp."
  def ms_left(socket, now_s \\ System.system_time(:second)) do
    case socket.assigns[:token_exp] do
      exp when is_integer(exp) -> max(0, (exp + @leeway_s - now_s) * 1000)
      _ -> nil
    end
  end

  @doc "Call from every channel's join, after the join is accepted."
  def arm(socket) do
    case ms_left(socket) do
      nil -> :ok
      ms -> Process.send_after(self(), :atto_token_expired, ms)
    end

    socket
  end

  @doc "Closes the socket the channel belongs to."
  def disconnect(socket) do
    ChatServiceWeb.Endpoint.broadcast(
      socket_id(socket.assigns.user_id, socket.assigns.socket_ref),
      "disconnect",
      %{}
    )
  end
end
