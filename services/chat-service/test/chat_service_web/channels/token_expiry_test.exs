defmodule ChatServiceWeb.TokenExpiryTest do
  # Nov 12 2026: a socket lives only as long as its token. A password reset
  # closes every session; a stolen token that connected once must not keep
  # receiving messages after its exp.
  use ExUnit.Case, async: false

  alias ChatServiceWeb.{PostChannel, TokenExpiry, UserChannel, UserSocket}

  @secret Application.compile_env!(:chat_service, ChatService.Auth.JWT)[:secret]
  @issuer "atto-sound-user-service"

  defp token(sub, exp) do
    signer = Joken.Signer.create("HS256", @secret)
    {:ok, jwt, _} = Joken.encode_and_sign(%{"sub" => sub, "iss" => @issuer, "exp" => exp}, signer)
    jwt
  end

  defp connect(exp) do
    socket = %Phoenix.Socket{
      assigns: %{},
      endpoint: ChatServiceWeb.Endpoint,
      handler: UserSocket,
      id: nil,
      transport: :websocket
    }

    {:ok, socket} = UserSocket.connect(%{"token" => token("281", exp)}, socket, %{})
    socket
  end

  test "the socket keeps its token's exp and gets an id of its own" do
    exp = System.system_time(:second) + 900
    a = connect(exp)
    b = connect(exp)
    assert a.assigns.token_exp == exp
    assert UserSocket.id(a) =~ "user_socket:281:"
    refute UserSocket.id(a) == UserSocket.id(b)
  end

  test "expired? and ms_left count the leeway" do
    now = System.system_time(:second)
    socket = connect(now + 900)
    refute TokenExpiry.expired?(socket, now)
    assert TokenExpiry.ms_left(socket, now) == (900 + 60) * 1000
    assert TokenExpiry.expired?(socket, now + 900 + 61)
    assert TokenExpiry.ms_left(socket, now + 2000) == 0
  end

  test "joining with a token past its exp is refused" do
    socket = connect(System.system_time(:second) + 900)
    stale = Phoenix.Socket.assign(socket, :token_exp, System.system_time(:second) - 3600)
    assert {:error, %{reason: "invalid_token"}} = UserChannel.join("user:281", %{}, stale)
    assert {:error, %{reason: "invalid_token"}} = PostChannel.join("post:1", %{}, stale)
    assert {:ok, _} = UserChannel.join("user:281", %{}, socket)
  end

  test "when the token ends the whole socket is disconnected" do
    socket = connect(System.system_time(:second) + 900)
    id = UserSocket.id(socket)
    ChatServiceWeb.Endpoint.subscribe(id)
    assert {:noreply, _} = UserChannel.handle_info(:atto_token_expired, socket)
    assert_receive %Phoenix.Socket.Broadcast{topic: ^id, event: "disconnect"}
  end

  test "the timer is armed on join" do
    now = System.system_time(:second)
    # A token whose exp + leeway is one second away.
    socket = now |> Kernel.+(900) |> connect() |> Phoenix.Socket.assign(:token_exp, now - 59)
    assert {:ok, _} = UserChannel.join("user:281", %{}, socket)
    assert_receive :atto_token_expired, 2_000
  end
end
