import json
import unittest

from fastapi.testclient import TestClient

from backend.main import app, simulation
from backend.models import StockItem, StorageLocation, Warehouse
from backend.rack_types import pack_packages, package_fits_location, package_rotation_for_location
from backend.simulation import WarehouseSimulation


class StorageCapacityTests(unittest.TestCase):
    def setUp(self):
        self.sim = WarehouseSimulation()
        simulation.custom_layout = None
        simulation.reset()

    def test_small_package_fits_empty_storage_bay(self):
        location = StorageLocation("X", "R", 1, 1, "R-L01-P01", width_mm=600, depth_mm=450, max_height_mm=400)
        self.assertTrue(package_fits_location((200, 150, 100), location))

    def test_oversized_package_does_not_fit_small_bay(self):
        location = StorageLocation("X", "R", 1, 1, "R-L01-P01", width_mm=600, depth_mm=450, max_height_mm=400)
        self.assertFalse(package_fits_location((800, 600, 500), location))

    def test_twelve_identical_packages_keep_exact_rotated_footprints(self):
        location = StorageLocation("X", "R", 1, 1, "R-L01-P01", width_mm=1350, depth_mm=1100, max_height_mm=1500)
        placements = pack_packages((200, 150, 100), 12, location)
        self.assertEqual(len(placements), 12)
        for placement in placements:
            expected = (150, 200) if placement["rotated"] else (200, 150)
            self.assertEqual((placement["length_mm"], placement["width_mm"]), expected)
            self.assertLessEqual(placement["x_mm"] + placement["length_mm"], location.width_mm)
            self.assertLessEqual(placement["y_mm"] + placement["width_mm"], location.depth_mm)
        first_row = [placement for placement in placements if placement["y_mm"] == 0]
        self.assertEqual(sum(not placement["rotated"] for placement in first_row), 6)
        self.assertEqual(sum(placement["rotated"] for placement in first_row), 1)
        self.assertEqual(sum(placement["length_mm"] for placement in first_row), location.width_mm)
        for index, first in enumerate(placements):
            for second in placements[index + 1:]:
                overlaps = (
                    first["x_mm"] < second["x_mm"] + second["length_mm"]
                    and first["x_mm"] + first["length_mm"] > second["x_mm"]
                    and first["y_mm"] < second["y_mm"] + second["width_mm"]
                    and first["y_mm"] + first["width_mm"] > second["y_mm"]
                )
                self.assertFalse(overlaps)

    def test_automatic_order_uses_a_realistic_profile(self):
        state = self.sim.add_order("Автоматическая коробка", (0, 0), (11, 1))
        order = next(row for row in state["warehouse"]["orders"] if row["item"] == "Автоматическая коробка")
        dimensions = (order["length_mm"], order["width_mm"], order["height_mm"])
        self.assertIn(dimensions, {(200, 150, 100), (400, 300, 250), (600, 400, 350), (800, 600, 500)})

    def test_multiple_packages_reserve_distinct_non_intersecting_bays(self):
        self.sim.add_order("Груз один", (0, 0), (11, 1), quantity=5, dimensions=(200, 150, 100))
        self.sim.add_order("Груз два", (0, 0), (11, 1), quantity=5, dimensions=(400, 300, 250))
        by_location = {}
        for item in self.sim.warehouse.inventory:
            if item.quantity:
                by_location.setdefault(item.location_id, []).extend(item.unit_placements)
        for location_id, rectangles in by_location.items():
            location = next(row for row in self.sim.warehouse.storage_locations if row.id == location_id)
            self.assertTrue(all(package_fits_location((rect["length_mm"], rect["width_mm"], rect["height_mm"]), location) for rect in rectangles))
            for index, first in enumerate(rectangles):
                for second in rectangles[index + 1:]:
                    overlaps = (
                        first["x_mm"] < second["x_mm"] + second["length_mm"]
                        and first["x_mm"] + first["length_mm"] > second["x_mm"]
                        and first["y_mm"] < second["y_mm"] + second["width_mm"]
                        and first["y_mm"] + first["width_mm"] > second["y_mm"]
                    )
                    self.assertFalse(overlaps)

    def test_no_free_bay_rejects_new_placement(self):
        for location in self.sim.warehouse.storage_locations:
            occupied = self.sim._occupied_rectangles(location.id)
            placements = []
            while True:
                batch = pack_packages((200, 150, 100), 100, location, occupied + placements)
                if not batch:
                    break
                placements.extend(batch)
            if placements:
                rack = next(row for row in self.sim.warehouse.racks if row.id == location.rack_id)
                self.sim.warehouse.inventory.append(StockItem(
                    id=f"FILL-{location.id}", name="Заполнение", position=rack.service_point or rack.position,
                    size="small", product_id=f"FILL-{location.id}", location_id=location.id,
                    quantity=len(placements), unit_placements=placements,
                ))
        with self.assertRaisesRegex(ValueError, "Нет свободной ячейки"):
            self.sim.add_order("Нет места", (0, 0), (11, 1), dimensions=(200, 150, 100))

    def test_horizontal_rotation_can_make_package_fit(self):
        location = StorageLocation("X", "R", 1, 1, "R-L01-P01", width_mm=300, depth_mm=400, max_height_mm=500)
        dimensions = (400, 300, 200)
        self.assertTrue(package_fits_location(dimensions, location))
        self.assertTrue(package_rotation_for_location(dimensions, location))

    def test_emptying_a_bay_makes_it_available_again(self):
        for existing in self.sim.warehouse.orders:
            existing.status = "completed"
        self.sim.add_order("Забор всего остатка", (3, 1), (11, 1), product_id="SKU-001", quantity=12)
        order = self.sim.warehouse.orders[-1]
        self.sim.start()
        robot = next(row for row in self.sim.warehouse.robots if row.order_id == order.id)
        self.sim.driver_action(robot.id, order.id, "accept")
        for _ in range(100):
            if robot.driver_phase == "confirm_pickup":
                break
            self.sim.tick()
        self.assertEqual(robot.driver_phase, "confirm_pickup")
        stock = self.sim._get_stock_item("SKU-001")
        freed_location = stock.location_id
        self.sim.driver_action(robot.id, order.id, "pickup")
        self.assertEqual(stock.unit_placements, [])
        self.assertFalse(next(row for row in self.sim.state()["warehouse"]["storage_locations"] if row["id"] == freed_location)["occupied"])
        self.sim.add_order("Повторное размещение", (0, 0), (11, 1), dimensions=(200, 150, 100))
        placed = next(row for row in self.sim.warehouse.inventory if row.name == "Повторное размещение")
        self.assertEqual(placed.location_id, freed_location)

    def test_sequential_orders_claim_distinct_physical_positions(self):
        self.sim.add_order("Первый груз", (0, 0), (11, 1), dimensions=(200, 150, 100))
        self.sim.add_order("Второй груз", (0, 0), (11, 1), dimensions=(200, 150, 100))
        first, second = [row for row in self.sim.warehouse.inventory if row.name in ("Первый груз", "Второй груз")]
        self.assertEqual(first.location_id, second.location_id)
        first_placement, second_placement = first.unit_placements[0], second.unit_placements[0]
        self.assertNotEqual((first_placement["x_mm"], first_placement["y_mm"]), (second_placement["x_mm"], second_placement["y_mm"]))
        self.assertFalse(
            first_placement["x_mm"] < second_placement["x_mm"] + second_placement["length_mm"]
            and first_placement["x_mm"] + first_placement["length_mm"] > second_placement["x_mm"]
            and first_placement["y_mm"] < second_placement["y_mm"] + second_placement["width_mm"]
            and first_placement["y_mm"] + first_placement["width_mm"] > second_placement["y_mm"]
        )

    def test_two_robots_reserve_disjoint_packages(self):
        for existing in self.sim.warehouse.orders:
            existing.status = "completed"
        self.sim.add_order("Заказ робота один", (3, 1), (11, 1), product_id="SKU-001", quantity=6)
        self.sim.add_order("Заказ робота два", (3, 1), (11, 1), product_id="SKU-001", quantity=6)
        self.sim.start()
        stock = self.sim._get_stock_item("SKU-001")
        order_ids = [order.id for order in self.sim.warehouse.orders if order.item.startswith("Заказ робота")]
        first = stock.reserved_placements[order_ids[0]]
        second = stock.reserved_placements[order_ids[1]]
        self.assertEqual(len(first), 6)
        self.assertEqual(len(second), 6)
        self.assertFalse(set((item["x_mm"], item["y_mm"]) for item in first) & set((item["x_mm"], item["y_mm"]) for item in second))

    def test_api_reports_no_capacity_for_dimensions_that_fit_no_bay(self):
        client = TestClient(app)
        response = client.post("/api/orders", json={
            "item": "Длинная коробка", "pickup": [3, 1], "dropoff": [11, 1],
            "length_mm": 1500, "width_mm": 100, "height_mm": 100,
        })
        self.assertEqual(response.status_code, 409)
        self.assertIn("Нет свободной ячейки хранения", response.json()["detail"])

    def test_small_volume_with_incompatible_shape_is_rejected(self):
        # This box has less volume than a bay but is longer than every rack bay
        # and too long to fit when its horizontal sides are rotated.
        with self.assertRaisesRegex(ValueError, "Нет свободной ячейки"):
            self.sim.add_order("Длинномер", (0, 0), (11, 1), dimensions=(1500, 100, 100))

    def test_snapshot_restore_preserves_dimensions_and_placement(self):
        self.sim.add_order("Сохраняемый груз", (0, 0), (11, 1), dimensions=(400, 300, 250))
        snapshot = json.loads(json.dumps(self.sim.warehouse.to_dict()))
        restored = Warehouse.from_dict(snapshot)
        original = next(row for row in self.sim.warehouse.inventory if row.name == "Сохраняемый груз")
        restored_item = next(row for row in restored.inventory if row.name == "Сохраняемый груз")
        self.assertEqual((restored_item.length_mm, restored_item.width_mm, restored_item.height_mm), (400, 300, 250))
        self.assertEqual((restored_item.location_id, restored_item.placement_x_mm, restored_item.placement_y_mm, restored_item.rotated), (original.location_id, original.placement_x_mm, original.placement_y_mm, original.rotated))
        self.assertEqual(restored.to_dict()["storage_locations"], snapshot["storage_locations"])

    def test_invalid_saved_package_positions_are_repacked_without_losing_stock(self):
        self.sim.add_order("Заказ для повреждённого снимка", (0, 0), (11, 1), product_id="SKU-001", quantity=2)
        self.sim.start()
        snapshot = json.loads(json.dumps(self.sim.warehouse.to_dict()))
        saved = next(row for row in snapshot["inventory"] if row["id"] == "SKU-001")
        dimensions = (saved["length_mm"], saved["width_mm"], saved["height_mm"])
        quantity = saved["quantity"]
        location_id = saved["location_id"]
        saved["unit_placements"][0]["x_mm"] = 999999
        for rectangles in saved["reserved_placements"].values():
            if rectangles:
                rectangles[0]["x_mm"] = 999999
        for order in snapshot["orders"]:
            for allocation in order["allocations"]:
                if allocation["stock_item_id"] == saved["id"] and allocation["placement_snapshot"]:
                    allocation["placement_snapshot"][0]["x_mm"] = 999999

        restored = Warehouse.from_dict(snapshot)
        item = next(row for row in restored.inventory if row.id == saved["id"])
        location = next(row for row in restored.storage_locations if row.id == location_id)
        self.assertEqual((item.length_mm, item.width_mm, item.height_mm), dimensions)
        self.assertEqual(item.quantity, quantity)
        self.assertEqual(len(item.unit_placements), quantity)
        for placement in item.unit_placements:
            self.assertGreaterEqual(placement["x_mm"], 0)
            self.assertGreaterEqual(placement["y_mm"], 0)
            self.assertLessEqual(placement["x_mm"] + placement["length_mm"], location.width_mm)
            self.assertLessEqual(placement["y_mm"] + placement["width_mm"], location.depth_mm)
        for index, first in enumerate(item.unit_placements):
            for second in item.unit_placements[index + 1:]:
                overlaps = (
                    first["x_mm"] < second["x_mm"] + second["length_mm"]
                    and first["x_mm"] + first["length_mm"] > second["x_mm"]
                    and first["y_mm"] < second["y_mm"] + second["width_mm"]
                    and first["y_mm"] + first["width_mm"] > second["y_mm"]
                )
                self.assertFalse(overlaps)
        active_order = next(order for order in restored.orders if order.id in item.reserved_placements)
        allocation = next(row for row in active_order.allocations if row.stock_item_id == item.id)
        self.assertEqual(allocation.placement_snapshot, item.reserved_placements[active_order.id])

    def test_legacy_snapshot_gets_dimensions_and_recomputed_positions(self):
        snapshot = json.loads(json.dumps(self.sim.warehouse.to_dict()))
        for item in snapshot["inventory"]:
            for field in ("length_mm", "width_mm", "height_mm", "unit_placements", "reserved_placements", "placement_x_mm", "placement_y_mm", "rotated"):
                item.pop(field, None)
        for location in snapshot["storage_locations"]:
            for field in ("width_mm", "depth_mm", "max_height_mm", "x_mm", "y_mm"):
                location.pop(field, None)
        restored = Warehouse.from_dict(snapshot)
        self.assertTrue(all(item.length_mm > 0 and item.width_mm > 0 and item.height_mm > 0 for item in restored.inventory))
        self.assertTrue(all(len(item.unit_placements) == item.quantity for item in restored.inventory))

    def test_manual_order_dimensions_are_validated_and_returned(self):
        client = TestClient(app)
        incomplete = client.post("/api/orders", json={
            "item": "Неполные размеры", "pickup": [3, 1], "dropoff": [11, 1], "length_mm": 300,
        })
        self.assertEqual(incomplete.status_code, 422)
        response = client.post("/api/orders", json={
            "item": "Ручной груз", "pickup": [3, 1], "dropoff": [11, 1],
            "length_mm": 300, "width_mm": 200, "height_mm": 150,
        })
        self.assertEqual(response.status_code, 200)
        order = next(row for row in response.json()["warehouse"]["orders"] if row["item"] == "Ручной груз")
        self.assertEqual((order["length_mm"], order["width_mm"], order["height_mm"]), (300, 200, 150))

    def test_dimension_edit_repacks_stock_or_rejects_without_changing_it(self):
        client = TestClient(app)
        before = simulation._get_stock_item("SKU-001")
        original = (before.length_mm, before.width_mm, before.height_mm, list(before.unit_placements))
        impossible = client.put("/api/inventory/SKU-001/dimensions", json={
            "length_mm": 1500, "width_mm": 100, "height_mm": 100,
        })
        self.assertEqual(impossible.status_code, 409)
        self.assertEqual((before.length_mm, before.width_mm, before.height_mm, before.unit_placements), original)
        accepted = client.put("/api/inventory/SKU-001/dimensions", json={
            "length_mm": 250, "width_mm": 200, "height_mm": 150,
        })
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual((before.length_mm, before.width_mm, before.height_mm), (250, 200, 150))
        self.assertEqual(len(before.unit_placements), before.quantity)


if __name__ == "__main__":
    unittest.main()
