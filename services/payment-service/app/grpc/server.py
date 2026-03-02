"""gRPC server implementing PaymentService from payment.proto.

Because the generated stubs live outside the service tree we hand-code
the descriptors using the generic ``grpc.aio`` API.  The message
wire-format follows the proto definitions exactly, so any gRPC client
generated from payment.proto can call this server.
"""

import logging
from concurrent import futures
from uuid import UUID

import grpc
import grpc.aio

from app.config import settings
from app.database import async_session
from app.repositories.transaction_repo import TransactionRepository

logger = logging.getLogger(__name__)

_server: grpc.aio.Server | None = None

# ── Fully-qualified proto service / method names ───────────────────

_SERVICE_NAME = "atto.payment.PaymentService"
_METHOD_GET_TRANSACTION_STATUS = f"/{_SERVICE_NAME}/GetTransactionStatus"
_METHOD_GET_USER_SUBSCRIPTION = f"/{_SERVICE_NAME}/GetUserSubscription"


# ── Minimal protobuf helpers (no codegen required) ─────────────────
# We use raw bytes so that we don't need generated Python stubs.
# The wire format is simple enough to encode/decode by hand via the
# ``protobuf`` library's descriptor-less API.

def _decode_string_field(data: bytes, field_number: int) -> str:
    """Decode a length-delimited string field from a raw protobuf message."""
    idx = 0
    while idx < len(data):
        # Read the tag
        tag_byte = data[idx]
        idx += 1
        f_number = tag_byte >> 3
        wire_type = tag_byte & 0x07

        if wire_type == 2:  # length-delimited
            # Read varint length
            length = 0
            shift = 0
            while True:
                b = data[idx]
                idx += 1
                length |= (b & 0x7F) << shift
                shift += 7
                if (b & 0x80) == 0:
                    break
            value = data[idx : idx + length]
            idx += length
            if f_number == field_number:
                return value.decode("utf-8")
        elif wire_type == 0:  # varint
            while data[idx] & 0x80:
                idx += 1
            idx += 1
        else:
            break
    return ""


def _encode_string_field(field_number: int, value: str) -> bytes:
    """Encode a single string field into raw protobuf bytes."""
    encoded = value.encode("utf-8")
    tag = (field_number << 3) | 2
    length = len(encoded)
    # Simple varint encoding for the length
    varint = bytearray()
    while length > 0x7F:
        varint.append((length & 0x7F) | 0x80)
        length >>= 7
    varint.append(length & 0x7F)
    return bytes([tag]) + bytes(varint) + encoded


def _encode_message(**fields: dict[int, str]) -> bytes:
    """Encode multiple string fields into a protobuf message."""
    result = b""
    for field_number, value in fields.items():
        if value:
            result += _encode_string_field(field_number, value)
    return result


# ── gRPC handler implementations ──────────────────────────────────

class PaymentServicer:
    """Implements the gRPC PaymentService methods."""

    async def GetTransactionStatus(
        self,
        request_data: bytes,
        context: grpc.aio.ServicerContext,
    ) -> bytes:
        """Look up a transaction's status by ID."""
        transaction_id = _decode_string_field(request_data, 1)
        if not transaction_id:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("transaction_id is required")
            return b""

        try:
            UUID(transaction_id)
        except ValueError:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("transaction_id must be a valid UUID")
            return b""

        async with async_session() as session:
            repo = TransactionRepository(session)
            txn = await repo.get_transaction_by_id(UUID(transaction_id))

        if txn is None:
            context.set_code(grpc.StatusCode.NOT_FOUND)
            context.set_details("Transaction not found")
            return b""

        txn_type = txn.type if isinstance(txn.type, str) else txn.type.value
        txn_status = txn.status if isinstance(txn.status, str) else txn.status.value

        return _encode_message(**{
            1: str(txn.id),
            2: txn_status,
            3: str(txn.amount),
            4: txn.currency,
            5: txn_type,
            6: txn.created_at.isoformat() if txn.created_at else "",
        })

    async def GetUserSubscription(
        self,
        request_data: bytes,
        context: grpc.aio.ServicerContext,
    ) -> bytes:
        """Look up a user's active subscription."""
        user_id = _decode_string_field(request_data, 1)
        if not user_id:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("user_id is required")
            return b""

        try:
            UUID(user_id)
        except ValueError:
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details("user_id must be a valid UUID")
            return b""

        async with async_session() as session:
            repo = TransactionRepository(session)
            sub = await repo.get_active_subscription(UUID(user_id))

        if sub is None:
            context.set_code(grpc.StatusCode.NOT_FOUND)
            context.set_details("No active subscription found")
            return b""

        sub_plan = sub.plan if isinstance(sub.plan, str) else sub.plan.value
        sub_status = sub.status if isinstance(sub.status, str) else sub.status.value

        return _encode_message(**{
            1: str(sub.id),
            2: sub_plan,
            3: sub_status,
            4: sub.starts_at.isoformat() if sub.starts_at else "",
            5: sub.expires_at.isoformat() if sub.expires_at else "",
        })


# ── Generic unary handler adapter ─────────────────────────────────

def _unary_unary_handler(method_fn):
    """Wrap an async method into a grpc.aio GenericRpcHandler."""

    async def handler(request_data, context):
        return await method_fn(request_data, context)

    return grpc.unary_unary_rpc_method_handler(
        handler,
        request_deserializer=None,
        response_serializer=None,
    )


class PaymentGenericHandler(grpc.GenericRpcHandler):
    """Routes incoming gRPC calls to the appropriate servicer method."""

    def __init__(self) -> None:
        self._servicer = PaymentServicer()
        self._routes = {
            _METHOD_GET_TRANSACTION_STATUS: _unary_unary_handler(
                self._servicer.GetTransactionStatus
            ),
            _METHOD_GET_USER_SUBSCRIPTION: _unary_unary_handler(
                self._servicer.GetUserSubscription
            ),
        }

    def service(self, handler_call_details):
        return self._routes.get(handler_call_details.method)


# ── Server lifecycle ──────────────────────────────────────────────

async def serve_grpc() -> None:
    """Start the async gRPC server on the configured port."""
    global _server
    _server = grpc.aio.server(futures.ThreadPoolExecutor(max_workers=4))
    _server.add_generic_rpc_handlers([PaymentGenericHandler()])

    listen_addr = f"[::]:{settings.grpc_port}"
    _server.add_insecure_port(listen_addr)
    await _server.start()
    logger.info("gRPC server listening on %s", listen_addr)


async def stop_grpc() -> None:
    """Gracefully stop the gRPC server."""
    global _server
    if _server is not None:
        await _server.stop(grace=5)
        _server = None
        logger.info("gRPC server stopped")
